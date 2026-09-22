# SALT — Amplify Application Deployment Guide

## Prerequisites
- Node.js 18+ installed
- AWS CLI configured with your credentials
- Git repository connected

## Local Development

```bash
cd amplify-app
npm install
npm start
# Opens at http://localhost:3000
```

## Deploy to AWS Amplify Hosting

### Option A — Via AWS Console (Recommended)

1. Go to: https://console.aws.amazon.com/amplify
2. Click "Create new app"
3. Choose "Host web app"
4. Connect to GitHub → select mrleom/SALT or topeolukunle/SALT
5. Choose branch: main (after PR merged) or feature/amplify-application
6. Build settings: amplify.yml is already in the repo
7. Click Save and deploy
8. Wait for deployment — takes 3-5 minutes
9. Copy your Amplify URL: https://main.xxxxx.amplifyapp.com

### Option B — Via Amplify CLI

```bash
npm install -g @aws-amplify/cli
amplify init
amplify hosting add
amplify publish
```

## After Deployment — Update These Values

### 1. Update aws-exports.js
Replace `https://localhost` with your Amplify URL:
```js
redirectSignIn:  'https://main.xxxxx.amplifyapp.com/',
redirectSignOut: 'https://main.xxxxx.amplifyapp.com/',
```

### 2. Update Cognito Callback URLs
Cognito → User pool - mbkhei → App clients
→ My web app - asset-tracker → Login pages → Edit
→ Add: https://main.xxxxx.amplifyapp.com
→ Remove: https://localhost

### 3. Update API Gateway CORS (optional)
Once Amplify URL is known, replace * with specific URL in:
- Lambda respond() function: Access-Control-Allow-Origin
- API Gateway Gateway Responses

## File Structure

```
amplify-app/
├── amplify.yml          ← Amplify build configuration
├── package.json         ← Dependencies
├── vite.config.js       ← Vite build config
├── public/
│   └── index.html       ← HTML entry point
└── src/
    ├── main.jsx         ← React entry point, Amplify.configure()
    ├── App.jsx          ← Routes, auth guards, permission guards
    ├── aws-exports.js   ← Cognito, API, S3 config
    ├── index.css        ← Global styles and design tokens
    ├── components/
    │   └── Layout.jsx   ← Sidebar navigation
    ├── hooks/
    │   └── useAuth.js   ← Auth state, group, permissions
    ├── pages/
    │   ├── Dashboard.jsx      ← Stats, recent assets, category breakdown
    │   ├── AssetList.jsx      ← Table, search, filter by category/status
    │   ├── AssetDetail.jsx    ← All asset records, financials, maintenance
    │   ├── RegisterAsset.jsx  ← 5-step wizard with photo upload
    │   ├── EditAsset.jsx      ← Edit all fields by tab
    │   ├── LogMaintenance.jsx ← Record maintenance event
    │   ├── Reports.jsx        ← Aggregated financial reports
    │   └── Login.jsx          ← Cognito hosted UI wrapper
    └── utils/
        ├── api.js         ← All API calls with auth token
        └── helpers.js     ← Formatters, constants, badges
```

## How Authentication Works

1. User visits app → RequireAuth checks for Cognito session
2. Not signed in → redirect to /login
3. Amplify Authenticator renders Cognito Hosted UI
4. User signs in → Cognito issues JWT token
5. useAuth hook reads cognito:groups from token
6. can() function checks if group has required permission
7. All API calls in api.js attach id_token as Authorization header
8. API Gateway validates token via CognitoAuthorizer
9. Lambda reads cognito:groups and enforces RBAC

## Pages by Role

| Page              | Employee | Technician | Manager | Admin | Auditor |
|-------------------|----------|------------|---------|-------|---------|
| Dashboard         | ✓        | ✓          | ✓       | ✓     | ✓       |
| Asset List        | ✓        | ✓          | ✓       | ✓     | ✓       |
| Asset Detail      | ✓        | ✓          | ✓       | ✓     | ✓       |
| Register Asset    | ✗        | ✗          | ✗       | ✓     | ✗       |
| Edit Asset        | ✗        | ✓          | ✗       | ✓     | ✗       |
| Log Maintenance   | ✗        | ✓          | ✗       | ✓     | ✗       |
| Reports           | ✗        | ✗          | ✓       | ✓     | ✓       |
