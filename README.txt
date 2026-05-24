Hushh Netlify Admin

This is the tiny admin panel for login emails.
It shows only:
- email
- login date

The data stays in Netlify Blobs.

Deploy:
1. Extract this folder.
2. Push this folder to a GitHub repo OR deploy it with Netlify CLI.
3. In Netlify, add these environment variables:

HUSHH_ADMIN_TOKEN=your_admin_password
HUSHH_INGEST_TOKEN=your_app_ingest_key

4. Deploy.
5. Open your Netlify URL and enter HUSHH_ADMIN_TOKEN.

After Netlify is live, update Hushh app .env:

EXPO_PUBLIC_LOGIN_EVENTS_API_URL=https://your-site-name.netlify.app
EXPO_PUBLIC_LOGIN_EVENTS_API_KEY=your_app_ingest_key

Then rebuild the APK.

Important:
Netlify drag-and-drop static deploy is not enough for this because this admin panel uses Netlify Functions and Blobs. Use Git deploy or Netlify CLI.
