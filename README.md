# SALT — Smart Asset Lifecycle Tracker (Personal)

Personal repository for the SALT infrastructure and Amplify application.
Team repository: https://github.com/mrleom/SALT

## Structure

infrastructure/
  cloudformation/
    dynamodb.yaml        DynamoDB table — deploy first
    app-complete.yaml    Cognito, S3, Lambda, API Gateway, Amplify
  sam/
    dynamodb.yaml        DynamoDB table — deploy first
    template.yaml        SAM version of app-complete
    functions/
      apihandler/app.py  All 17 API routes with RBAC (643 lines)
      calculator/app.py  Depreciation calculator (138 lines)

amplify-app/             React Vite frontend application
docs/                    Project documentation

## Deploy Order
1. Deploy dynamodb.yaml first
2. Deploy app-complete.yaml or sam template.yaml second

## AWS Resources
- DynamoDB:    AssetManagement table (2 LSIs, 6 GSIs)
- Cognito:     User Pool with 5 groups
- API Gateway: 17 routes with Cognito authorizer
- Lambda:      AssetAPIHandler + AssetDepreciationCalculator
- S3:          asset-tracker-photos-137696816941
- Amplify:     React Vite frontend hosting
