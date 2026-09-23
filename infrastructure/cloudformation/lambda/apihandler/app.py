import json
import boto3
import os
import uuid
import logging
from datetime import datetime, date
from decimal import Decimal, ROUND_HALF_UP
from boto3.dynamodb.conditions import Key, Attr

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('REGION', 'us-east-1'))
lambda_client = boto3.client('lambda', region_name=os.environ.get('REGION', 'us-east-1'))
s3_client = boto3.client('s3', region_name=os.environ.get('REGION', 'us-east-1'))

TABLE_NAME = os.environ['TABLE_NAME']
PHOTO_BUCKET = os.environ.get('PHOTO_BUCKET', 'asset-tracker-photos-137696816941')
CALCULATOR_FUNCTION = os.environ.get('CALCULATOR_FUNCTION', 'AssetDepreciationCalculator')
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '*')

table = dynamodb.Table(TABLE_NAME)

ALLOWED_STATUSES = [
    'Available', 'Assigned', 'Checked Out',
    'In Maintenance', 'Damaged', 'Lost', 'Stolen', 'Retired'
]

ALLOWED_CONDITIONS = ['Excellent', 'Good', 'Fair', 'Poor', 'Critical']

ALLOWED_CATEGORIES = [
    'IT Equipment', 'Furniture', 'Vehicle', 'Machinery',
    'Office Equipment', 'Medical Equipment', 'Safety Equipment', 'Other'
]


# ── helpers ──────────────────────────────────────────────────────────────────

def respond(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        },
        'body': json.dumps(body, default=decimal_default),
    }


def decimal_default(obj):
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError


def now_iso():
    return datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')


def today_iso():
    return date.today().isoformat()


def get_user_info(event):
    """Extract username and groups from Cognito JWT claims."""
    try:
        claims = event['requestContext']['authorizer']['claims']
        username = claims.get('email') or claims.get('cognito:username', 'unknown')
        groups_raw = claims.get('cognito:groups', '')
        groups = groups_raw if isinstance(groups_raw, list) else groups_raw.split(',') if groups_raw else []
        return username, [g.strip() for g in groups]
    except (KeyError, TypeError):
        return 'unknown', []


def can(groups, *allowed_groups):
    """Return True if user belongs to any of the allowed groups."""
    return bool(set(groups) & set(allowed_groups))


def invoke_calculator(asset_id):
    """Synchronously invoke the depreciation calculator for one asset."""
    try:
        lambda_client.invoke(
            FunctionName=CALCULATOR_FUNCTION,
            InvocationType='RequestResponse',
            Payload=json.dumps({'asset_id': asset_id}),
        )
        logger.info(f'Calculator invoked for {asset_id}')
    except Exception as e:
        logger.warning(f'Calculator invocation failed for {asset_id}: {e}')


def generate_maintenance_recommendation(asset_id, profile, location, financials):
    """Generate a MAINTENANCE_RECOMMENDATION record based on asset state."""
    condition = (location or {}).get('condition', 'Good')
    life_consumed = float((financials or {}).get('useful_life_consumed_pct', 0) or 0)
    num_repairs = int((financials or {}).get('number_of_repairs', 0) or 0)
    last_maintenance = (location or {}).get('last_maintenance_date', 'NOT-SET')

    # Scoring
    score = 0
    if condition in ('Poor', 'Critical'):
        score += 3
    elif condition == 'Fair':
        score += 1

    if life_consumed > 80:
        score += 3
    elif life_consumed > 60:
        score += 2
    elif life_consumed > 40:
        score += 1

    if num_repairs > 5:
        score += 2
    elif num_repairs > 2:
        score += 1

    if score >= 5:
        priority = 'Critical'
        action = 'Replace or retire immediately'
    elif score >= 3:
        priority = 'High'
        action = 'Schedule maintenance within 30 days'
    elif score >= 1:
        priority = 'Medium'
        action = 'Schedule maintenance within 90 days'
    else:
        priority = 'Low'
        action = 'Routine check at next scheduled maintenance'

    # Estimated completion
    from datetime import timedelta
    days_map = {'Critical': 7, 'High': 30, 'Medium': 90, 'Low': 180}
    completion_date = (date.today() + timedelta(days=days_map[priority])).isoformat()

    rec = {
        'asset_id': asset_id,
        'record_type': 'MAINTENANCE_RECOMMENDATION',
        'priority': priority,
        'recommended_action': action,
        'estimated_completion_date': completion_date,
        'based_on_condition': condition,
        'based_on_life_consumed_pct': str(life_consumed),
        'based_on_num_repairs': num_repairs,
        'last_maintenance_date': last_maintenance,
        'generated_at': now_iso(),
        'event_date': today_iso(),
        'created_at': now_iso(),
        'updated_at': now_iso(),
    }

    table.put_item(Item=rec)
    logger.info(f'Maintenance recommendation generated for {asset_id}: {priority}')
    return rec


# ── route handlers ────────────────────────────────────────────────────────────

def handle_list_assets(event, username, groups):
    """GET /assets — list all PROFILE records."""
    scan_result = table.scan(
        FilterExpression=Attr('record_type').eq('PROFILE')
    )
    items = scan_result.get('Items', [])
    
    # Sort by created_at descending
    items.sort(key=lambda x: x.get('created_at', ''), reverse=True)
    
    return respond(200, {
        'assets': items,
        'count': len(items)
    })

def handle_create_asset(event, username, groups):
    """POST /assets — create a new asset (Administrator only)."""
    if not can(groups, 'Administrator'):
        return respond(403, {'message': 'Forbidden: Administrator role required'})

    body = json.loads(event.get('body') or '{}')
    asset_id = body.get('asset_id') or f"AST-{str(uuid.uuid4())[:8].upper()}"
    now = now_iso()

    profile = {
        'asset_id': asset_id,
        'record_type': 'PROFILE',
        'name': body.get('name', 'NOT-SET'),
        'description': body.get('description', 'NOT-SET'),
        'category': body.get('category', 'Other'),
        'manufacturer': body.get('manufacturer', 'NOT-SET'),
        'model': body.get('model', 'NOT-SET'),
        'serial_number': body.get('serial_number', 'NOT-SET'),
        'asset_tag': body.get('asset_tag', 'NOT-SET'),
        'acquired_date': body.get('acquired_date', today_iso()),
        'in_service_date': body.get('in_service_date', 'NOT-SET'),
        'image_key': body.get('image_key', 'NOT-SET'),
        'ai_review_status': 'Pending',
        'ai_confidence_score': 'NOT-SET',
        'ai_review_notes': 'NOT-SET',
        'status': body.get('status', 'Available'),
        'event_date': today_iso(),
        'created_at': now,
        'updated_at': now,
        'created_by': username,
    }

    # Validate category and status
    if profile['category'] not in ALLOWED_CATEGORIES:
        return respond(400, {'message': f"Invalid category. Allowed: {ALLOWED_CATEGORIES}"})
    if profile['status'] not in ALLOWED_STATUSES:
        return respond(400, {'message': f"Invalid status. Allowed: {ALLOWED_STATUSES}"})

    table.put_item(Item=profile)

    # Create STATUS record
    status_rec = {
        'asset_id': asset_id,
        'record_type': 'STATUS',
        'status': profile['status'],
        'acquired_date': profile['acquired_date'],
        'current_status': profile['status'],
        'event_date': today_iso(),
        'created_at': now,
        'updated_at': now,
    }
    table.put_item(Item=status_rec)

    # Create FINANCIALS if provided
    if body.get('purchase_value'):
        fin = {
            'asset_id': asset_id,
            'record_type': 'FINANCIALS',
            'purchase_value': Decimal(str(body['purchase_value'])),
            'purchase_date': body.get('purchase_date', today_iso()),
            'in_service_date': body.get('in_service_date', today_iso()),
            'salvage_value': Decimal(str(body.get('salvage_value', 0))),
            'useful_life_years': Decimal(str(body.get('useful_life_years', 5))),
            'depreciation_method': 'straight-line',
            'warranty_expiration': body.get('warranty_expiration', 'NOT-SET'),
            'total_repair_cost': Decimal('0'),
            'number_of_repairs': 0,
            'event_date': today_iso(),
            'created_at': now,
            'updated_at': now,
        }
        table.put_item(Item=fin)
        invoke_calculator(asset_id)

    # Create initial LOCATION record
    location = {
        'asset_id': asset_id,
        'record_type': f"LOCATION#{today_iso()}",
        'building': body.get('building', 'NOT-SET'),
        'floor': body.get('floor', 'NOT-SET'),
        'room': body.get('room', 'NOT-SET'),
        'assigned_to': body.get('assigned_to', 'NOT-SET'),
        'assigned_user_id': body.get('assigned_user_id', 'NOT-SET'),
        'assigned_department': body.get('assigned_department', 'NOT-SET'),
        'condition': body.get('condition', 'Good'),
        'last_cleaning_date': 'NOT-SET',
        'last_maintenance_date': 'NOT-SET',
        'recommended_next_maintenance': 'NOT-SET',
        'event_date': today_iso(),
        'created_at': now,
        'updated_at': now,
    }
    table.put_item(Item=location)

    # Generate maintenance recommendation
    generate_maintenance_recommendation(asset_id, profile, location, None)

    return respond(201, {'asset_id': asset_id, 'message': 'Asset created', 'profile': profile})


def handle_get_asset(event, username, groups, asset_id):
    """GET /assets/{id} — get all records for one asset."""
    result = table.query(
        KeyConditionExpression=Key('asset_id').eq(asset_id)
    )
    items = result.get('Items', [])
    if not items:
        return respond(404, {'message': f'Asset {asset_id} not found'})
    return respond(200, {'asset_id': asset_id, 'records': items, 'count': len(items)})


def handle_update_asset(event, username, groups, asset_id):
    """PUT /assets/{id} — update asset (Administrator, Technician)."""
    if not can(groups, 'Administrator', 'Technician'):
        return respond(403, {'message': 'Forbidden'})

    body = json.loads(event.get('body') or '{}')
    record_type = body.get('record_type', 'PROFILE')
    now = now_iso()

    # Build update expression dynamically
    body.pop('asset_id', None)
    body.pop('record_type', None)
    body['updated_at'] = now
    body['updated_by'] = username

    if record_type == 'PROFILE':
        if 'status' in body and body['status'] not in ALLOWED_STATUSES:
            return respond(400, {'message': f"Invalid status. Allowed: {ALLOWED_STATUSES}"})
        if 'category' in body and body['category'] not in ALLOWED_CATEGORIES:
            return respond(400, {'message': f"Invalid category."})

    # Convert floats to Decimal
    def to_decimal(v):
        if isinstance(v, float):
            return Decimal(str(v))
        return v

    body = {k: to_decimal(v) for k, v in body.items()}

    update_expr = 'SET ' + ', '.join(f'#{k} = :{k}' for k in body)
    expr_names = {f'#{k}': k for k in body}
    expr_values = {f':{k}': v for k, v in body.items()}

    table.update_item(
        Key={'asset_id': asset_id, 'record_type': record_type},
        UpdateExpression=update_expr,
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
    )

    # Re-run calculator and recommendation after any update
    if record_type == 'FINANCIALS':
        invoke_calculator(asset_id)

    # Get latest location and financials for recommendation
    result = table.query(KeyConditionExpression=Key('asset_id').eq(asset_id))
    items = result.get('Items', [])
    profile = next((i for i in items if i['record_type'] == 'PROFILE'), None)
    financials = next((i for i in items if i['record_type'] == 'FINANCIALS'), None)
    location = next((i for i in items if i['record_type'].startswith('LOCATION#')), None)

    if location:
        generate_maintenance_recommendation(asset_id, profile, location, financials)

    return respond(200, {'message': 'Asset updated', 'asset_id': asset_id})


def handle_delete_asset(event, username, groups, asset_id):
    """DELETE /assets/{id} — delete all records (Administrator only)."""
    if not can(groups, 'Administrator'):
        return respond(403, {'message': 'Forbidden: Administrator role required'})

    result = table.query(KeyConditionExpression=Key('asset_id').eq(asset_id))
    items = result.get('Items', [])
    if not items:
        return respond(404, {'message': f'Asset {asset_id} not found'})

    with table.batch_writer() as batch:
        for item in items:
            batch.delete_item(Key={'asset_id': item['asset_id'], 'record_type': item['record_type']})

    return respond(200, {'message': f'Asset {asset_id} and all records deleted', 'count': len(items)})


def handle_get_history(event, username, groups, asset_id):
    """GET /assets/{id}/history — full timeline (Administrator, Auditor)."""
    if not can(groups, 'Administrator', 'Auditor'):
        return respond(403, {'message': 'Forbidden'})

    result = table.query(
        KeyConditionExpression=Key('asset_id').eq(asset_id)
    )
    items = result.get('Items', [])
    items.sort(key=lambda x: x.get('event_date', ''), reverse=True)
    return respond(200, {'asset_id': asset_id, 'history': items, 'count': len(items)})


def handle_get_reports(event, username, groups):
    """GET /reports — aggregated totals (Manager, Administrator, Auditor)."""
    if not can(groups, 'Manager', 'Administrator', 'Auditor'):
        return respond(403, {'message': 'Forbidden'})

    scan = table.scan(FilterExpression=Attr('record_type').eq('PROFILE'))
    items = scan.get('Items', [])

    by_status = {}
    by_category = {}
    total_value = Decimal('0')

    for item in items:
        s = item.get('status', 'Unknown')
        c = item.get('category', 'Unknown')
        by_status[s] = by_status.get(s, 0) + 1
        by_category[c] = by_category.get(c, 0) + 1

    fin_scan = table.scan(FilterExpression=Attr('record_type').eq('FINANCIALS'))
    for fin in fin_scan.get('Items', []):
        total_value += Decimal(str(fin.get('current_book_value') or fin.get('purchase_value') or 0))

    return respond(200, {
        'total_assets': len(items),
        'by_status': by_status,
        'by_category': by_category,
        'total_book_value': float(total_value),
        'generated_at': now_iso(),
    })


# ── NEW ROUTES ────────────────────────────────────────────────────────────────

def handle_search(event, username, groups):
    """GET /assets/search?q=keyword"""
    q = (event.get('queryStringParameters') or {}).get('q', '').lower().strip()
    if not q:
        return respond(400, {'message': 'Missing query parameter q'})

    scan = table.scan(FilterExpression=Attr('record_type').eq('PROFILE'))
    items = scan.get('Items', [])

    fields = ['name', 'manufacturer', 'model', 'serial_number', 'asset_tag', 'description', 'category']
    results = [
        i for i in items
        if any(q in str(i.get(f, '')).lower() for f in fields)
    ]
    return respond(200, {'results': results, 'count': len(results), 'query': q})


def handle_filter_by_category(event, username, groups, category):
    """GET /assets/category/{cat}"""
    result = table.query(
        IndexName='category-index',
        KeyConditionExpression=Key('category').eq(category)
    )
    return respond(200, {'assets': result.get('Items', []), 'count': result.get('Count', 0), 'category': category})


def handle_filter_by_status(event, username, groups, status):
    """GET /assets/status/{status}"""
    result = table.query(
        IndexName='status-index',
        KeyConditionExpression=Key('status').eq(status)
    )
    return respond(200, {'assets': result.get('Items', []), 'count': result.get('Count', 0), 'status': status})


def handle_filter_by_department(event, username, groups, dept):
    """GET /assets/department/{dept} — Manager, Administrator, Auditor."""
    if not can(groups, 'Manager', 'Administrator', 'Auditor'):
        return respond(403, {'message': 'Forbidden'})

    result = table.query(
        IndexName='assigned-department-index',
        KeyConditionExpression=Key('assigned_department').eq(dept)
    )
    return respond(200, {'assets': result.get('Items', []), 'count': result.get('Count', 0), 'department': dept})


def handle_get_maintenance_recommendation(event, username, groups, asset_id):
    """GET /assets/{id}/maintenance/recommendation"""
    result = table.get_item(
        Key={'asset_id': asset_id, 'record_type': 'MAINTENANCE_RECOMMENDATION'}
    )
    item = result.get('Item')
    if not item:
        return respond(404, {'message': 'No recommendation found. Save the asset to generate one.'})
    return respond(200, item)


def handle_regenerate_maintenance_recommendation(event, username, groups, asset_id):
    """POST /assets/{id}/maintenance/recommendation — Technician, Administrator."""
    if not can(groups, 'Technician', 'Administrator'):
        return respond(403, {'message': 'Forbidden'})

    result = table.query(KeyConditionExpression=Key('asset_id').eq(asset_id))
    items = result.get('Items', [])
    if not items:
        return respond(404, {'message': f'Asset {asset_id} not found'})

    profile = next((i for i in items if i['record_type'] == 'PROFILE'), None)
    financials = next((i for i in items if i['record_type'] == 'FINANCIALS'), None)
    location = next((i for i in items if i['record_type'].startswith('LOCATION#')), None)

    rec = generate_maintenance_recommendation(asset_id, profile, location, financials)
    return respond(200, {'message': 'Recommendation regenerated', 'recommendation': rec})


def handle_photo_upload(event, username, groups, asset_id):
    """POST /assets/{id}/photo — returns presigned S3 URL."""
    if not can(groups, 'Technician', 'Administrator'):
        return respond(403, {'message': 'Forbidden'})

    body = json.loads(event.get('body') or '{}')
    file_type = body.get('file_type', 'image/jpeg')
    ext_map = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp'}
    ext = ext_map.get(file_type, 'jpg')

    key = f"assets/{asset_id}/{uuid.uuid4()}.{ext}"

    presigned_url = s3_client.generate_presigned_url(
        'put_object',
        Params={
            'Bucket': PHOTO_BUCKET,
            'Key': key,
            'ContentType': file_type,
        },
        ExpiresIn=300,
    )

    # Store the S3 key on the PROFILE record
    table.update_item(
        Key={'asset_id': asset_id, 'record_type': 'PROFILE'},
        UpdateExpression='SET image_key = :k, updated_at = :u',
        ExpressionAttributeValues={':k': key, ':u': now_iso()},
    )

    return respond(200, {
        'presigned_url': presigned_url,
        'key': key,
        'bucket': PHOTO_BUCKET,
        'expires_in_seconds': 300,
    })


def handle_ai_review(event, username, groups, asset_id):
    """POST /assets/{id}/ai-review — Bedrock placeholder."""
    if not can(groups, 'Technician', 'Administrator'):
        return respond(403, {'message': 'Forbidden'})

    # Update status to InReview immediately
    table.update_item(
        Key={'asset_id': asset_id, 'record_type': 'PROFILE'},
        UpdateExpression='SET ai_review_status = :s, updated_at = :u',
        ExpressionAttributeValues={':s': 'InReview', ':u': now_iso()},
    )

    # TODO: invoke Bedrock here in next milestone
    # For now return placeholder
    return respond(202, {
        'message': 'AI review queued (Bedrock integration pending)',
        'asset_id': asset_id,
        'ai_review_status': 'InReview',
    })


def handle_filter_by_ai_status(event, username, groups, status):
    """GET /assets/ai-review-status/{status} — uses ai-review-status-index GSI."""
    result = table.query(
        IndexName='ai-review-status-index',
        KeyConditionExpression=Key('ai_review_status').eq(status)
    )
    return respond(200, {'assets': result.get('Items', []), 'count': result.get('Count', 0), 'ai_review_status': status})


def handle_filter_by_condition(event, username, groups, condition):
    """GET /assets/condition/{condition} — uses condition-index GSI."""
    result = table.query(
        IndexName='condition-index',
        KeyConditionExpression=Key('condition').eq(condition)
    )
    return respond(200, {'assets': result.get('Items', []), 'count': result.get('Count', 0), 'condition': condition})


def handle_post_maintenance(event, username, groups, asset_id):
    """POST /assets/{id}/maintenance — log a maintenance event."""
    if not can(groups, 'Technician', 'Administrator'):
        return respond(403, {'message': 'Forbidden'})

    body = json.loads(event.get('body') or '{}')
    now = now_iso()
    rec = {
        'asset_id': asset_id,
        'record_type': f"MAINTENANCE#{today_iso()}",
        'maintenance_type': body.get('maintenance_type', 'Routine'),
        'maintenance_cost': Decimal(str(body.get('cost', 0))),
        'performed_by': body.get('performed_by', username),
        'notes': body.get('notes', ''),
        'next_due_date': body.get('next_due_date', 'NOT-SET'),
        'event_date': today_iso(),
        'created_at': now,
        'updated_at': now,
    }
    table.put_item(Item=rec)

    # Update FINANCIALS repair count and total cost
    try:
        table.update_item(
            Key={'asset_id': asset_id, 'record_type': 'FINANCIALS'},
            UpdateExpression='ADD number_of_repairs :one, total_repair_cost :cost SET updated_at = :u',
            ExpressionAttributeValues={
                ':one': 1,
                ':cost': Decimal(str(body.get('cost', 0))),
                ':u': now,
            },
        )
    except Exception:
        pass  # FINANCIALS record may not exist

    return respond(201, {'message': 'Maintenance event recorded', 'record': rec})


# ── main handler ──────────────────────────────────────────────────────────────

def lambda_handler(event, context):
    logger.info(f"Event: {json.dumps(event)}")

    method = event.get('httpMethod', 'GET')
    path = event.get('path', '/')
    params = event.get('pathParameters') or {}

    # CORS preflight
    if method == 'OPTIONS':
        return respond(200, {'message': 'OK'})

    username, groups = get_user_info(event)

    # ── route matching ──────────────────────────────────────────────────────

    # GET /assets/search
    if method == 'GET' and path == '/assets/search':
        return handle_search(event, username, groups)

    # GET /assets/category/{cat}
    if method == 'GET' and path.startswith('/assets/category/'):
        cat = params.get('cat') or path.split('/')[-1]
        return handle_filter_by_category(event, username, groups, cat)

    # GET /assets/status/{status}
    if method == 'GET' and path.startswith('/assets/status/'):
        status = params.get('status') or path.split('/')[-1]
        return handle_filter_by_status(event, username, groups, status)

    # GET /assets/department/{dept}
    if method == 'GET' and path.startswith('/assets/department/'):
        dept = params.get('dept') or path.split('/')[-1]
        return handle_filter_by_department(event, username, groups, dept)

    # GET /assets/ai-review-status/{status}
    if method == 'GET' and path.startswith('/assets/ai-review-status/'):
        status = params.get('status') or path.split('/')[-1]
        return handle_filter_by_ai_status(event, username, groups, status)

    # GET /assets/condition/{condition}
    if method == 'GET' and path.startswith('/assets/condition/'):
        condition = params.get('condition') or path.split('/')[-1]
        return handle_filter_by_condition(event, username, groups, condition)

    # /assets (no ID)
    if path == '/assets':
        if method == 'GET':
            return handle_list_assets(event, username, groups)
        if method == 'POST':
            return handle_create_asset(event, username, groups)

    # /assets/{id}/maintenance/recommendation
    asset_id = params.get('id') or params.get('assetId')

    if path.endswith('/maintenance/recommendation'):
        if not asset_id:
            parts = path.split('/')
            asset_id = parts[2] if len(parts) > 2 else None
        if method == 'GET':
            return handle_get_maintenance_recommendation(event, username, groups, asset_id)
        if method == 'POST':
            return handle_regenerate_maintenance_recommendation(event, username, groups, asset_id)

    # /assets/{id}/maintenance
    if path.endswith('/maintenance'):
        if not asset_id:
            parts = path.split('/')
            asset_id = parts[2] if len(parts) > 2 else None
        if method == 'POST':
            return handle_post_maintenance(event, username, groups, asset_id)

    # /assets/{id}/photo
    if path.endswith('/photo'):
        if not asset_id:
            parts = path.split('/')
            asset_id = parts[2] if len(parts) > 2 else None
        if method == 'POST':
            return handle_photo_upload(event, username, groups, asset_id)

    # /assets/{id}/ai-review
    if path.endswith('/ai-review'):
        if not asset_id:
            parts = path.split('/')
            asset_id = parts[2] if len(parts) > 2 else None
        if method == 'POST':
            return handle_ai_review(event, username, groups, asset_id)

    # /assets/{id}/history
    if path.endswith('/history'):
        if not asset_id:
            parts = path.split('/')
            asset_id = parts[2] if len(parts) > 2 else None
        if method == 'GET':
            return handle_get_history(event, username, groups, asset_id)

    # /assets/{id}
    if asset_id:
        if method == 'GET':
            return handle_get_asset(event, username, groups, asset_id)
        if method == 'PUT':
            return handle_update_asset(event, username, groups, asset_id)
        if method == 'DELETE':
            return handle_delete_asset(event, username, groups, asset_id)

    # GET /reports
    if method == 'GET' and path == '/reports':
        return handle_get_reports(event, username, groups)

    return respond(404, {'message': f'Route not found: {method} {path}'})