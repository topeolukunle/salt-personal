import boto3
import json
import os
from decimal import Decimal
from datetime import date

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['TABLE_NAME'])


def calculate(asset_id):
    """
    Read FINANCIALS record, calculate all depreciation values,
    write results back to DynamoDB.
    """
    response = table.get_item(
        Key={'asset_id': asset_id, 'record_type': 'FINANCIALS'}
    )
    item = response.get('Item')
    if not item:
        return {'error': f'No FINANCIALS record found for {asset_id}'}

    # Read base facts
    purchase_value    = Decimal(str(item.get('purchase_value', 0)))
    salvage_value     = Decimal(str(item.get('salvage_value', 0)))
    useful_life_years = Decimal(str(item.get('useful_life_years', 0)))
    in_service_date   = date.fromisoformat(
        item.get('in_service_date', date.today().isoformat()))
    today             = date.today()

    # Guard against zero useful life
    if useful_life_years == 0:
        return {'asset_id': asset_id,
                'error': 'useful_life_years is zero or missing in DynamoDB'}

    # Calculate years owned
    days_owned  = (today - in_service_date).days
    years_owned = Decimal(str(days_owned)) / Decimal('365.25')

    # Annual Depreciation = (Purchase Value - Salvage Value) / Useful Life Years
    annual_depreciation = (purchase_value - salvage_value) / useful_life_years

    # Accumulated Depreciation (capped at Purchase Value - Salvage Value)
    max_depreciation         = purchase_value - salvage_value
    accumulated_depreciation = min(annual_depreciation * years_owned, max_depreciation)

    # Current Book Value = max(Salvage Value, Purchase Value - Accumulated)
    current_book_value = max(salvage_value, purchase_value - accumulated_depreciation)

    # Useful Life Consumed % (capped at 100%)
    useful_life_consumed_pct = min(
        (years_owned / useful_life_years) * Decimal('100'),
        Decimal('100')
    )

    # Estimated Replacement Date = In Service Date + Useful Life Years
    replacement_year      = in_service_date.year + int(useful_life_years)
    estimated_replacement = in_service_date.replace(
        year=replacement_year).strftime('%Y-%m-%d')

    # Write calculated values back to DynamoDB
    table.update_item(
        Key={'asset_id': asset_id, 'record_type': 'FINANCIALS'},
        UpdateExpression='''
            SET annual_depreciation      = :ad,
                accumulated_depreciation = :acd,
                current_book_value       = :cbv,
                useful_life_consumed_pct = :pct,
                estimated_replacement    = :er,
                last_calculated_date     = :lcd
        ''',
        ExpressionAttributeValues={
            ':ad':  annual_depreciation.quantize(Decimal('0.01')),
            ':acd': accumulated_depreciation.quantize(Decimal('0.01')),
            ':cbv': current_book_value.quantize(Decimal('0.01')),
            ':pct': useful_life_consumed_pct.quantize(Decimal('0.01')),
            ':er':  estimated_replacement,
            ':lcd': today.strftime('%Y-%m-%d')
        }
    )

    return {
        'asset_id':                 asset_id,
        'annual_depreciation':      str(annual_depreciation.quantize(Decimal('0.01'))),
        'accumulated_depreciation': str(accumulated_depreciation.quantize(Decimal('0.01'))),
        'current_book_value':       str(current_book_value.quantize(Decimal('0.01'))),
        'useful_life_consumed_pct': str(useful_life_consumed_pct.quantize(Decimal('0.01'))),
        'estimated_replacement':    estimated_replacement,
        'last_calculated_date':     today.strftime('%Y-%m-%d')
    }


def handler(event, context):
    """
    Lambda entry point.

    Single asset:  {"asset_id": "AST-0001"}  -> calculates one asset
    All assets:    {}                          -> calculates all assets
    EventBridge:   {}                          -> same as all assets (runs annually)
    """
    asset_id = event.get('asset_id')

    if asset_id:
        # Single asset mode
        result = calculate(asset_id)
        return {'statusCode': 200, 'body': json.dumps(result)}
    else:
        # All assets mode - scans for all FINANCIALS records
        response = table.scan(
            FilterExpression=boto3.dynamodb.conditions.Attr('record_type').eq('FINANCIALS')
        )
        items   = response['Items']

        # Handle pagination for large tables
        while 'LastEvaluatedKey' in response:
            response = table.scan(
                FilterExpression=boto3.dynamodb.conditions.Attr('record_type').eq('FINANCIALS'),
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            items.extend(response['Items'])

        results = []
        errors  = []
        for item in items:
            result = calculate(item['asset_id'])
            if 'error' in result:
                errors.append(result)
            else:
                results.append(result)

        return {
            'statusCode': 200,
            'body': json.dumps({
                'processed': len(results),
                'errors':    len(errors),
                'failed':    errors
            })
        }
