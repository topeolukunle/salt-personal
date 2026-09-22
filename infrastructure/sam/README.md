# AWS SAM Infrastructure

Two-stack deployment for SALT Smart Asset Lifecycle Tracker.

## Stack 1 — DynamoDB Table (deploy first)

  dynamodb.yaml — deploy via CloudFormation

  aws cloudformation deploy \
    --template-file dynamodb.yaml \
    --stack-name SALT-DynamoDB-dev \
    --parameter-overrides Environment=dev TableName=AssetManagement \
    --region us-east-1

## Stack 2 — Application (deploy second)

  template.yaml + functions/

  sam build
  sam deploy \
    --stack-name SALT-App-dev \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides \
      Environment=dev \
      TableName=AssetManagement \
      CognitoDomainPrefix=asset-tracker-salt-2026 \
      PhotoBucketName=asset-tracker-photos-137696816941 \
      GitHubRepo=https://github.com/topeolukunle/salt-personal \
      GitHubBranch=main \
      AmplifyToken=YOUR_GITHUB_TOKEN \
    --region us-east-1

## Lambda Functions

  functions/apihandler/app.py   643 lines — all 17 routes with RBAC
  functions/calculator/app.py   138 lines — straight-line depreciation
