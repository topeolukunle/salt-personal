import boto3
import json
import os
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from boto3.dynamodb.conditions import Key, Attr

dynamodb = boto3.resource('dynamodb')
table    = dynamodb.Table(os.environ['TABLE_NAME'])
s3       = boto3.client('s3')
lambda_c = boto3.client('lambda')

BUCKET_NAME   = os.environ.get('PHOTO_BUCKET', 'asset-tracker-photos-137696816941')
CALCULATOR_FN = os.environ.get('CALCULATOR_FUNCTION', 'AssetDepreciationCalculator')

ALLOWED_STATUSES = [
    'Available', 'Assigned', 'Checked Out',
    'In Maintenance', 'Damaged', 'Lost', 'Stolen', 'Retired'
]

PERMISSIONS = {
    'Administrator': ['read', 'create', 'update', 'delete', 'reports', 'manage'],
    'Auditor':       ['read', 'reports'],
    'Manager':       ['read', 'reports'],
    'Technician':    ['read', 'update'],
    'Employee':      ['read'],
}


def respond(code, body):
    return {
        'statusCode': code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        },
        'body': json.dumps(body, default=str)
    }


def get_next_asset_id():
    resp = table.scan(
        FilterExpression=Attr('record_type').eq('PROFILE'),
        ProjectionExpression='asset_id'
    )
    ids = [int(i['asset_id'].replace('AST-', '')) for i in resp['Items'] if i['asset_id'].startswith('AST-')]
    next_num = max(ids) + 1 if ids else 1
    return f'AST-{next_num:04d}'


def invoke_calculator(asset_id):
    try:
        lambda_c.invoke(
            FunctionName=CALCULATOR_FN,
            InvocationType='RequestResponse',
            Payload=json.dumps({'asset_id': asset_id})
        )
    except Exception as e:
        print(f'Calculator error for {asset_id}: {e}')


def generate_maintenance_recommendation(asset_id, profile, financials, status, location):
    today = date.today()
    category = profile.get('category', 'Unknown')
    condition = location.get('condition', 'Good')
    usage_level = status.get('usage_level', 'Daily')
    environment = status.get('environment', 'Indoor')
    last_cleaning = location.get('last_cleaning_date', 'NOT-SET')
    last_maintenance = location.get('last_maintenance_date', 'NOT-SET')
    number_of_repairs = int(financials.get('number_of_repairs', 0))
    warranty_exp = financials.get('warranty_expiration', 'NOT-SET')
    life_pct = float(financials.get('useful_life_consumed_pct', 0))
    in_service = financials.get('in_service_date', today.isoformat())

    # Calculate asset age in years
    try:
        in_service_date = date.fromisoformat(in_service)
        age_years = (today - in_service_date).days / 365.25
    except Exception:
        age_years = 0

    # Determine priority and action
    priority = 'Low'
    action = 'Inspect'
    interval = 'Every 12 months'
    completion_days = 90
    replacement_window = 'Not yet required'
    explanation_parts = []

    # Condition-based rules
    if condition in ['Poor', 'Critical']:
        priority = 'Critical'
        action = 'Maintain'
        completion_days = 7
        explanation_parts.append(f'Asset is in {condition} condition requiring immediate attention.')
    elif condition == 'Fair':
        priority = 'High'
        action = 'Maintain'
        completion_days = 30
        explanation_parts.append(f'Asset condition rated Fair indicating deterioration.')

    # Repair frequency
    if number_of_repairs >= 5:
        priority = 'Critical'
        action = 'Replace'
        replacement_window = 'Within 3 months'
        explanation_parts.append(f'Asset has required {number_of_repairs} repairs suggesting end of reliable life.')
    elif number_of_repairs >= 3:
        if priority not in ['Critical']:
            priority = 'High'
        action = 'Maintain'
        replacement_window = 'Within 12 months'
        explanation_parts.append(f'Repeated repairs ({number_of_repairs}) indicate reliability concerns.')

    # Life consumed
    if life_pct >= 100:
        priority = 'Critical'
        action = 'Replace'
        replacement_window = 'Immediately'
        explanation_parts.append('Asset has consumed 100% of its useful life.')
    elif life_pct >= 85:
        if priority not in ['Critical']:
            priority = 'High'
        action = 'Replace' if action != 'Replace' else action
        replacement_window = 'Within 6 months'
        explanation_parts.append(f'Asset has consumed {life_pct:.0f}% of useful life.')

    # Category-specific cleaning intervals
    category_intervals = {
        'IT Equipment':   ('Clean', 'Every 3 months'),
        'Machinery':      ('Maintain', 'Every 6 months'),
        'Vehicle':        ('Maintain', 'Every 3 months'),
        'Furniture':      ('Clean', 'Every 6 months'),
        'Networking':     ('Inspect', 'Every 6 months'),
    }
    if category in category_intervals and action not in ['Replace', 'Maintain']:
        action = category_intervals[category][0]
        interval = category_intervals[category][1]

    # Outdoor environment accelerates wear
    if environment == 'Outdoor' and priority == 'Low':
        priority = 'Medium'
        explanation_parts.append('Outdoor environment accelerates wear and requires more frequent inspection.')

    # High usage
    if usage_level == 'Daily' and priority == 'Low':
        priority = 'Medium'
        interval = 'Every 3 months'

    # Check overdue maintenance
    if last_maintenance != 'NOT-SET':
        try:
            last_maint_date = date.fromisoformat(last_maintenance)
            days_since = (today - last_maint_date).days
            if days_since > 365:
                if priority not in ['Critical', 'High']:
                    priority = 'High'
                explanation_parts.append(f'No maintenance recorded for {days_since} days.')
        except Exception:
            pass

    # Check overdue cleaning
    if last_cleaning != 'NOT-SET':
        try:
            last_clean_date = date.fromisoformat(last_cleaning)
            days_since = (today - last_clean_date).days
            if days_since > 180 and action not in ['Replace', 'Maintain']:
                action = 'Clean'
                if priority == 'Low':
                    priority = 'Medium'
                explanation_parts.append(f'Last cleaned {days_since} days ago.')
        except Exception:
            pass

    if not explanation_parts:
        explanation_parts.append(f'{category} asset in {condition} condition with {usage_level.lower()} usage.')

    completion_date = (today + timedelta(days=completion_days)).isoformat()

    rec = {
        'asset_id':                    asset_id,
        'record_type':                 'MAINTENANCE_RECOMMENDATION',
        'maintenance_priority':        priority,
        'recommended_action':          action,
        'recommended_completion_date': completion_date,
        'suggested_maintenance_interval': interval,
        'expected_replacement_window': replacement_window,
        'explanation':                 ' '.join(explanation_parts),
        'generated_at':                datetime.utcnow().isoformat(),
        'generated_by':                'System',
        'event_date':                  today.isoformat(),
    }
    try:
        table.put_item(Item=rec)
    except Exception as e:
        print(f'Recommendation write error: {e}')
    return rec


def handler(event, context):
    # Handle OPTIONS preflight
    if event.get('httpMethod') == 'OPTIONS':
        return respond(200, {'message': 'OK'})

    claims     = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
    user_group = claims.get('cognito:groups', 'Employee')
    user_email = claims.get('email', 'unknown')
    allowed    = PERMISSIONS.get(user_group, [])

    method   = event.get('httpMethod', 'GET')
    path     = event.get('path', '/')
    params   = event.get('pathParameters') or {}
    qparams  = event.get('queryStringParameters') or {}
    asset_id = params.get('id')
    body_str = event.get('body') or '{}'
    try:
        body = json.loads(body_str)
    except Exception:
        body = {}

    # ── GET /assets/search ─────────────────────────────────────────
    if method == 'GET' and path.endswith('/search'):
        if 'read' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        keyword = qparams.get('q', '').lower()
        resp = table.scan(FilterExpression=Attr('record_type').eq('PROFILE'))
        results = [i for i in resp['Items']
                   if keyword in i.get('name', '').lower()
                   or keyword in i.get('description', '').lower()
                   or keyword in i.get('manufacturer', '').lower()
                   or keyword in i.get('model', '').lower()
                   or keyword in i.get('serial_number', '').lower()
                   or keyword in i.get('asset_tag', '').lower()]
        return respond(200, results)

    # ── GET /assets/category/{cat} ─────────────────────────────────
    if method == 'GET' and '/category/' in path and not asset_id:
        if 'read' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        cat = path.split('/category/')[-1]
        resp = table.query(
            IndexName='category-index',
            KeyConditionExpression=Key('category').eq(cat)
        )
        return respond(200, resp['Items'])

    # ── GET /assets/status/{status} ────────────────────────────────
    if method == 'GET' and '/status/' in path and not asset_id:
        if 'read' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        status_val = path.split('/status/')[-1].replace('%20', ' ')
        resp = table.query(
            IndexName='status-index',
            KeyConditionExpression=Key('status').eq(status_val)
        )
        return respond(200, resp['Items'])

    # ── GET /assets/department/{dept} ─────────────────────────────
    if method == 'GET' and '/department/' in path and not asset_id:
        if 'read' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        dept = path.split('/department/')[-1].replace('%20', ' ')
        resp = table.query(
            IndexName='assigned-department-index',
            KeyConditionExpression=Key('assigned_department').eq(dept)
        )
        return respond(200, resp['Items'])

    # ── GET /assets ────────────────────────────────────────────────
    if method == 'GET' and path.rstrip('/').endswith('/assets'):
        if 'read' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        resp = table.scan(FilterExpression=Attr('record_type').eq('PROFILE'))
        items = resp['Items']
        while 'LastEvaluatedKey' in resp:
            resp = table.scan(
                FilterExpression=Attr('record_type').eq('PROFILE'),
                ExclusiveStartKey=resp['LastEvaluatedKey']
            )
            items.extend(resp['Items'])
        return respond(200, items)

    # ── POST /assets ───────────────────────────────────────────────
    if method == 'POST' and path.rstrip('/').endswith('/assets'):
        if 'create' not in allowed:
            return respond(403, {'message': 'Forbidden — Administrators only', 'yourRole': user_group})

        new_id = get_next_asset_id()
        today  = date.today().isoformat()
        now    = datetime.utcnow().isoformat()
        status_val = body.get('status', 'Available')
        if status_val not in ALLOWED_STATUSES:
            return respond(400, {'message': f'Invalid status. Must be one of: {ALLOWED_STATUSES}'})

        profile = {
            'asset_id':          new_id,
            'record_type':       'PROFILE',
            'name':              body.get('name', ''),
            'description':       body.get('description', ''),
            'category':          body.get('category', 'Unknown'),
            'manufacturer':      body.get('manufacturer', 'Unknown'),
            'model':             body.get('model', 'Unknown'),
            'serial_number':     body.get('serial_number', 'Unknown'),
            'asset_tag':         body.get('asset_tag', new_id),
            'acquired_date':     body.get('acquired_date', today),
            'in_service_date':   body.get('in_service_date', today),
            'image_key':         body.get('image_key', 'NOT-SET'),
            'ai_review_status':  body.get('ai_review_status', 'Pending'),
            'ai_confidence_score': body.get('ai_confidence_score', 'NOT-SET'),
            'event_date':        today,
            'created_at':        now,
            'updated_at':        now,
        }
        financials = {
            'asset_id':            new_id,
            'record_type':         'FINANCIALS',
            'purchase_value':      Decimal(str(body.get('purchase_value', 0))),
            'purchase_date':       body.get('purchase_date', today),
            'in_service_date':     body.get('in_service_date', today),
            'salvage_value':       Decimal(str(body.get('salvage_value', 0))),
            'useful_life_years':   Decimal(str(body.get('useful_life_years', 5))),
            'depreciation_method': body.get('depreciation_method', 'straight-line'),
            'warranty_expiration': body.get('warranty_expiration', 'NOT-SET'),
            'total_repair_cost':   Decimal('0'),
            'number_of_repairs':   Decimal('0'),
            'annual_depreciation': Decimal('0'),
            'accumulated_depreciation': Decimal('0'),
            'current_book_value':  Decimal(str(body.get('purchase_value', 0))),
            'useful_life_consumed_pct': Decimal('0'),
            'estimated_replacement': 'TBD',
            'last_calculated_date': 'TBD',
            'event_date':          today,
            'created_at':          now,
            'updated_at':          now,
        }
        status_rec = {
            'asset_id':             new_id,
            'record_type':          'STATUS',
            'status':               status_val,
            'acquired_date':        body.get('acquired_date', today),
            'current_status':       status_val,
            'usage_level':          body.get('usage_level', 'Daily'),
            'environment':          body.get('environment', 'Indoor'),
            'sold_date':            'NOT-SET',
            'sold_price':           'NOT-SET',
            'sold_to':              'NOT-SET',
            'checked_out_to':       'NOT-SET',
            'checked_out_date':     'NOT-SET',
            'expected_return_date': 'NOT-SET',
            'damage_description':   'NOT-SET',
            'theft_report_number':  'NOT-SET',
            'retirement_date':      'NOT-SET',
            'retirement_reason':    'NOT-SET',
            'event_date':           today,
            'created_at':           now,
            'updated_at':           now,
        }
        location_rec = {
            'asset_id':             new_id,
            'record_type':          f'LOCATION#{today}',
            'building':             body.get('building', 'NOT-SET'),
            'floor':                body.get('floor', 'NOT-SET'),
            'room':                 body.get('room', 'NOT-SET'),
            'assigned_to':          body.get('assigned_to', 'NOT-SET'),
            'assigned_user_id':     body.get('assigned_user_id', 'NOT-SET'),
            'assigned_department':  body.get('assigned_department', 'NOT-SET'),
            'condition':            body.get('condition', 'Good'),
            'last_cleaning_date':   body.get('last_cleaning_date', 'NOT-SET'),
            'last_maintenance_date': 'NOT-SET',
            'last_inspection_date': 'NOT-SET',
            'next_inspection_date': 'NOT-SET',
            'recommended_next_maintenance': 'NOT-SET',
            'moved_date':           today,
            'event_date':           today,
            'created_at':           now,
            'updated_at':           now,
        }

        with table.batch_writer() as batch:
            batch.put_item(Item=profile)
            batch.put_item(Item=financials)
            batch.put_item(Item=status_rec)
            batch.put_item(Item=location_rec)

        invoke_calculator(new_id)

        # Re-read financials after calculation
        fin_item = table.get_item(Key={'asset_id': new_id, 'record_type': 'FINANCIALS'}).get('Item', financials)
        rec = generate_maintenance_recommendation(new_id, profile, fin_item, status_rec, location_rec)

        return respond(201, {
            'asset_id': new_id,
            'message':  f'Asset {new_id} created successfully',
            'financials': fin_item,
            'maintenance_recommendation': rec
        })

    # ── GET /assets/{id}/history ───────────────────────────────────
    if method == 'GET' and asset_id and 'history' in path:
        if 'read' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        resp = table.query(
            IndexName='asset-by-date-index',
            KeyConditionExpression=Key('asset_id').eq(asset_id),
            ScanIndexForward=True
        )
        return respond(200, resp['Items'])

    # ── GET /assets/{id}/maintenance-recommendation ────────────────
    if method == 'GET' and asset_id and 'maintenance-recommendation' in path:
        if 'read' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        resp = table.get_item(Key={'asset_id': asset_id, 'record_type': 'MAINTENANCE_RECOMMENDATION'})
        item = resp.get('Item')
        if not item:
            return respond(404, {'message': f'No recommendation found for {asset_id}'})
        return respond(200, item)

    # ── POST /assets/{id}/maintenance-recommendation ───────────────
    if method == 'POST' and asset_id and 'maintenance-recommendation' in path:
        if 'update' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        all_recs = table.query(KeyConditionExpression=Key('asset_id').eq(asset_id))['Items']
        profile = next((r for r in all_recs if r['record_type'] == 'PROFILE'), {})
        financials = next((r for r in all_recs if r['record_type'] == 'FINANCIALS'), {})
        status_rec = next((r for r in all_recs if r['record_type'] == 'STATUS'), {})
        location_rec = next((r for r in all_recs if 'LOCATION#' in r.get('record_type', '')), {})
        rec = generate_maintenance_recommendation(asset_id, profile, financials, status_rec, location_rec)
        return respond(200, rec)

    # ── POST /assets/{id}/photo ────────────────────────────────────
    if method == 'POST' and asset_id and path.endswith('/photo'):
        if 'update' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        content_type = body.get('content_type', 'image/jpeg')
        s3_key = f'assets/{asset_id}/photo.jpg'
        url = s3.generate_presigned_url(
            ClientMethod='put_object',
            Params={'Bucket': BUCKET_NAME, 'Key': s3_key, 'ContentType': content_type},
            ExpiresIn=300
        )
        return respond(200, {'upload_url': url, 'key': s3_key, 'expires_in': 300})

    # ── POST /assets/{id}/ai-review ────────────────────────────────
    if method == 'POST' and asset_id and 'ai-review' in path:
        if 'update' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        return respond(200, {'message': 'AI review endpoint ready. Bedrock integration coming in next milestone.'})

    # ── GET /assets/{id} ──────────────────────────────────────────
    if method == 'GET' and asset_id:
        if 'read' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        resp = table.query(KeyConditionExpression=Key('asset_id').eq(asset_id))
        if not resp['Items']:
            return respond(404, {'message': f'Asset {asset_id} not found'})
        return respond(200, resp['Items'])

    # ── PUT /assets/{id} ──────────────────────────────────────────
    if method == 'PUT' and asset_id:
        if 'update' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        today = date.today().isoformat()
        now   = datetime.utcnow().isoformat()

        # Update PROFILE
        profile_updates = {k: v for k, v in body.items()
                          if k in ['name','description','category','manufacturer','model',
                                   'serial_number','asset_tag','image_key','ai_review_status']}
        if profile_updates:
            profile_updates['updated_at'] = now
            expr = 'SET ' + ', '.join(f'#{k}=:{k}' for k in profile_updates)
            table.update_item(
                Key={'asset_id': asset_id, 'record_type': 'PROFILE'},
                UpdateExpression=expr,
                ExpressionAttributeNames={f'#{k}': k for k in profile_updates},
                ExpressionAttributeValues={f':{k}': v for k, v in profile_updates.items()}
            )

        # Update FINANCIALS
        fin_updates = {k: v for k, v in body.items()
                      if k in ['purchase_value','salvage_value','useful_life_years',
                               'depreciation_method','warranty_expiration',
                               'total_repair_cost','number_of_repairs','purchase_date']}
        if fin_updates:
            fin_updates['updated_at'] = now
            for k in ['purchase_value','salvage_value','useful_life_years','total_repair_cost','number_of_repairs']:
                if k in fin_updates:
                    fin_updates[k] = Decimal(str(fin_updates[k]))
            expr = 'SET ' + ', '.join(f'#{k}=:{k}' for k in fin_updates)
            table.update_item(
                Key={'asset_id': asset_id, 'record_type': 'FINANCIALS'},
                UpdateExpression=expr,
                ExpressionAttributeNames={f'#{k}': k for k in fin_updates},
                ExpressionAttributeValues={f':{k}': v for k, v in fin_updates.items()}
            )
            invoke_calculator(asset_id)

        # Update STATUS
        status_updates = {k: v for k, v in body.items()
                         if k in ['status','current_status','usage_level','environment',
                                  'checked_out_to','checked_out_date','expected_return_date',
                                  'damage_description','theft_report_number',
                                  'retirement_date','retirement_reason']}
        if 'status' in status_updates and status_updates['status'] not in ALLOWED_STATUSES:
            return respond(400, {'message': f'Invalid status. Must be one of: {ALLOWED_STATUSES}'})
        if status_updates:
            status_updates['updated_at'] = now
            if 'status' in status_updates:
                status_updates['current_status'] = status_updates['status']
            expr = 'SET ' + ', '.join(f'#{k}=:{k}' for k in status_updates)
            table.update_item(
                Key={'asset_id': asset_id, 'record_type': 'STATUS'},
                UpdateExpression=expr,
                ExpressionAttributeNames={f'#{k}': k for k in status_updates},
                ExpressionAttributeValues={f':{k}': v for k, v in status_updates.items()}
            )

        # Update LOCATION (create new LOCATION#{date} record)
        loc_updates = {k: v for k, v in body.items()
                      if k in ['building','floor','room','assigned_to','assigned_user_id',
                               'assigned_department','condition','last_cleaning_date',
                               'last_maintenance_date','last_inspection_date','next_inspection_date',
                               'recommended_next_maintenance']}
        if loc_updates:
            loc_updates['asset_id']   = asset_id
            loc_updates['record_type'] = f'LOCATION#{today}'
            loc_updates['moved_date'] = today
            loc_updates['event_date'] = today
            loc_updates['updated_at'] = now
            loc_updates['created_at'] = now
            table.put_item(Item=loc_updates)

        # Regenerate recommendation
        all_recs = table.query(KeyConditionExpression=Key('asset_id').eq(asset_id))['Items']
        profile  = next((r for r in all_recs if r['record_type'] == 'PROFILE'), {})
        fin_item = next((r for r in all_recs if r['record_type'] == 'FINANCIALS'), {})
        status_r = next((r for r in all_recs if r['record_type'] == 'STATUS'), {})
        loc_r    = next((r for r in all_recs if 'LOCATION#' in r.get('record_type', '')), {})
        rec = generate_maintenance_recommendation(asset_id, profile, fin_item, status_r, loc_r)

        return respond(200, {'message': f'Asset {asset_id} updated', 'maintenance_recommendation': rec})

    # ── DELETE /assets/{id} ───────────────────────────────────────
    if method == 'DELETE' and asset_id:
        if 'delete' not in allowed:
            return respond(403, {'message': 'Forbidden — Administrators only', 'yourRole': user_group})
        all_recs = table.query(KeyConditionExpression=Key('asset_id').eq(asset_id))['Items']
        with table.batch_writer() as batch:
            for rec in all_recs:
                batch.delete_item(Key={'asset_id': rec['asset_id'], 'record_type': rec['record_type']})
        return respond(200, {'message': f'Asset {asset_id} and all {len(all_recs)} records deleted'})

    # ── POST /assets/{id}/maintenance ─────────────────────────────
    if method == 'POST' and asset_id and 'maintenance' in path and 'recommendation' not in path:
        if 'update' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        today = date.today().isoformat()
        now   = datetime.utcnow().isoformat()
        cost  = Decimal(str(body.get('maintenance_cost', 0)))
        record = {
            'asset_id':           asset_id,
            'record_type':        f'MAINTENANCE#{today}',
            'maintenance_type':   body.get('maintenance_type', 'Scheduled'),
            'performed_by':       body.get('performed_by', user_email),
            'maintenance_cost':   cost,
            'next_due_date':      body.get('next_due_date', 'NOT-SET'),
            'notes':              body.get('notes', ''),
            'event_date':         today,
            'created_at':         now,
        }
        table.put_item(Item=record)
        # Update total repair cost
        table.update_item(
            Key={'asset_id': asset_id, 'record_type': 'FINANCIALS'},
            UpdateExpression='ADD total_repair_cost :c, number_of_repairs :one SET updated_at=:u',
            ExpressionAttributeValues={':c': cost, ':one': Decimal('1'), ':u': now}
        )
        # Update location record
        table.update_item(
            Key={'asset_id': asset_id, 'record_type': 'STATUS'},
            UpdateExpression='SET last_maintenance_date=:d, updated_at=:u',
            ExpressionAttributeValues={':d': today, ':u': now},
            ExpressionAttributeNames={}
        )
        return respond(201, {'message': f'Maintenance recorded for {asset_id}', 'record': record})

    # ── POST /assets/{id}/condition ───────────────────────────────
    if method == 'POST' and asset_id and 'condition' in path:
        if 'update' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        today = date.today().isoformat()
        now   = datetime.utcnow().isoformat()
        record = {
            'asset_id':    asset_id,
            'record_type': f'CONDITION#{today}',
            'condition':   body.get('condition', 'Good'),
            'notes':       body.get('notes', ''),
            'reported_by': user_email,
            'event_date':  today,
            'created_at':  now,
        }
        table.put_item(Item=record)
        return respond(201, {'message': f'Condition recorded for {asset_id}', 'record': record})

    # ── GET /reports ──────────────────────────────────────────────
    if method == 'GET' and 'reports' in path:
        if 'reports' not in allowed:
            return respond(403, {'message': 'Forbidden', 'yourRole': user_group})
        resp  = table.scan(FilterExpression=Attr('record_type').eq('FINANCIALS'))
        items = resp['Items']
        while 'LastEvaluatedKey' in resp:
            resp = table.scan(
                FilterExpression=Attr('record_type').eq('FINANCIALS'),
                ExclusiveStartKey=resp['LastEvaluatedKey']
            )
            items.extend(resp['Items'])
        total_book   = sum(float(i.get('current_book_value', 0)) for i in items)
        total_cost   = sum(float(i.get('purchase_value', 0)) for i in items)
        total_repair = sum(float(i.get('total_repair_cost', 0)) for i in items)
        by_category  = {}
        for i in items:
            cat = i.get('category', 'Unknown')
            if cat not in by_category:
                by_category[cat] = {'count': 0, 'book_value': 0}
            by_category[cat]['count'] += 1
            by_category[cat]['book_value'] += float(i.get('current_book_value', 0))
        return respond(200, {
            'total_assets':       len(items),
            'total_book_value':   round(total_book, 2),
            'total_purchase_cost': round(total_cost, 2),
            'total_repair_cost':  round(total_repair, 2),
            'total_depreciation': round(total_cost - total_book, 2),
            'by_category':        by_category,
            'generated_by':       user_email,
            'role':               user_group,
            'generated_at':       datetime.utcnow().isoformat()
        })

    return respond(404, {'message': 'Route not found', 'path': path, 'method': method})
