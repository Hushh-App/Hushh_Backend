# Hushh Admin Panel

This small Node server receives login events from the app and shows one row per email in the admin table. Repeated logins update the same email record with a latest-login timestamp, total count, and capped recent history.

## Netlify Deploy

The Netlify deployment uses `admin-panel/index.html` as the published admin UI and `netlify/functions/login-events.mjs` as the API. `netlify.toml` maps `/api/login-events` to that function.

Set these Netlify environment variables:

```env
HUSHH_ADMIN_TOKEN=change-this-admin-token
HUSHH_INGEST_TOKEN=change-this-ingest-token
```

Then set these app build variables before creating the APK:

```env
EXPO_PUBLIC_LOGIN_EVENTS_API_URL=https://your-netlify-site.netlify.app
EXPO_PUBLIC_LOGIN_EVENTS_API_KEY=change-this-ingest-token
```

## Local Run

```powershell
$env:HUSHH_ADMIN_TOKEN="change-this-admin-token"
$env:HUSHH_INGEST_TOKEN="change-this-ingest-token"
npm run admin:start
```

Open `http://localhost:4310` and enter the admin token.

The local server stores grouped user login summaries in `admin-panel/data/login-users.json`. If older raw login events exist in `login-events.json`, they are migrated into grouped summaries automatically.

## App Environment

Set these before building the APK:

```env
EXPO_PUBLIC_LOGIN_EVENTS_API_URL=https://your-admin-panel-domain.com
EXPO_PUBLIC_LOGIN_EVENTS_API_KEY=change-this-ingest-token
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=your_android_oauth_client_id.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=your_ios_oauth_client_id.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=your_web_oauth_client_id.apps.googleusercontent.com
```

The app sends login events to:

```text
POST /api/login-events
```

with the `x-hushh-api-key` header. The admin panel reads:

```text
GET /api/login-events
```

with the `x-admin-token` header.

## Google OAuth Setup

Use package name `com.hushh.app` for the Android OAuth client. The Android client must use the SHA-1 fingerprint of the certificate used to sign the APK. The current local release build is still using the debug signing config, so the debug SHA-1 is the one needed until a real release keystore is configured.
