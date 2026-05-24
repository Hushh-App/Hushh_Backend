import { getStore } from '@netlify/blobs';

const STORE_NAME = 'hushh-admin-settings';
const SETTINGS_KEY = 'settings.json';

const DEFAULT_SETTINGS = {
  contactUrl: 'https://calendly.com/contact-hushhapp/30min',
  updatedAt: null,
};

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    if (request.method === 'GET') {
      return json(await readSettings());
    }

    if (request.method === 'PUT') {
      if (!isAdminAuthorized(request)) {
        return json({ error: 'Unauthorized' }, 401);
      }

      const payload = await request.json().catch(() => ({}));
      const settings = await saveSettings(payload);
      return json(settings);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    return json(
      { error: error.statusCode ? error.message : 'Internal server error' },
      error.statusCode || 500
    );
  }
};

async function readSettings() {
  const store = getStore(STORE_NAME);
  const settings = await store.get(SETTINGS_KEY, { type: 'json' });
  return normalizeSettings(settings || DEFAULT_SETTINGS);
}

async function saveSettings(payload) {
  const store = getStore(STORE_NAME);
  const settings = normalizeSettings({
    ...await readSettings(),
    contactUrl: payload.contactUrl,
    updatedAt: new Date().toISOString(),
  });

  await store.setJSON(SETTINGS_KEY, settings);
  return settings;
}

function normalizeSettings(settings) {
  const contactUrl = normalizeUrl(settings?.contactUrl);

  return {
    contactUrl: contactUrl || DEFAULT_SETTINGS.contactUrl,
    updatedAt: safeString(settings?.updatedAt),
  };
}

function normalizeUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throwHttpError(400, 'Contact link must start with http:// or https://');
    }

    return url.toString();
  } catch (error) {
    if (error.statusCode) throw error;
    throwHttpError(400, 'Enter a valid contact link.');
  }
}

function isAdminAuthorized(request) {
  const url = new URL(request.url);
  const adminToken = process.env.HUSHH_ADMIN_TOKEN;
  const headerToken = request.headers.get('x-admin-token');
  const queryToken = url.searchParams.get('token');
  return Boolean(adminToken && (headerToken === adminToken || queryToken === adminToken));
}

function safeString(value) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, 500);
}

function throwHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,PUT,OPTIONS',
    'access-control-allow-headers': 'content-type,x-admin-token',
  };
}
