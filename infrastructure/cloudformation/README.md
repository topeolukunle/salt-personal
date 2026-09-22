# CloudFormation Infrastructure

Two-stack deployment for SALT Smart Asset Lifecycle Tracker.

## Stack 1 — DynamoDB Table (deploy first)

  dynamodb.yaml
  Creates: AssetManagement table with 2 LSIs and 6 GSIs
  Exports: TableName, TableArn, TableIndexArn

  aws cloudformation deploy \
    --template-file dynamodb.yaml \
    --stack-name SALT-DynamoDB-dev \
    --parameter-overrides Environment=dev TableName=AssetManagement \
    --region us-east-1

## Stack 2 — Application (deploy second)

  app-complete.yaml
  Creates: Cognito, S3, Lambda, API Gateway, Amplify Hosting

  aws cloudformation deploy \
    --template-file app-complete.yaml \
    --stack-name SALT-App-dev \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      Environment=dev \
      TableName=AssetManagement \
      CognitoDomainPrefix=asset-tracker-salt-2026 \
      PhotoBucketName=asset-tracker-photos-137696816941 \
      GitHubRepo=https://github.com/topeolukunle/salt-personal \
      GitHubBranch=main \
      AmplifyToken=YOUR_GITHUB_TOKEN \
    --region us-east-1
