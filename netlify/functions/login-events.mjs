import { getStore } from '@netlify/blobs';

const STORE_NAME = 'hushh-login-emails';
const EVENTS_KEY = 'events.json';
const MAX_EVENTS = 10000;

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    if (request.method === 'GET') {
      return listEvents(request);
    }

    if (request.method === 'POST') {
      return saveEvent(request);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    return json(
      { error: error.statusCode ? error.message : 'Internal server error' },
      error.statusCode || 500
    );
  }
};

async function listEvents(request) {
  if (!isAdminAuthorized(request)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const events = await readEvents();
  return json({ events });
}

async function saveEvent(request) {
  if (!isIngestAuthorized(request)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const event = createEvent(body);
  const events = await readEvents();
  await writeEvents([event, ...events].slice(0, MAX_EVENTS));

  return json({ ok: true });
}

async function readEvents() {
  const store = getStore(STORE_NAME);
  const events = await store.get(EVENTS_KEY, { type: 'json' });
  return Array.isArray(events) ? events : [];
}

async function writeEvents(events) {
  const store = getStore(STORE_NAME);
  await store.setJSON(EVENTS_KEY, events);
}

function createEvent(body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throwHttpError(400, 'Valid email is required');
  }

  return {
    email,
    signedInAt: safeString(body.signedInAt) || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  };
}

function isAdminAuthorized(request) {
  const adminToken = process.env.HUSHH_ADMIN_TOKEN;
  return Boolean(adminToken && request.headers.get('x-admin-token') === adminToken);
}

function isIngestAuthorized(request) {
  const ingestToken = process.env.HUSHH_INGEST_TOKEN;
  return Boolean(ingestToken && request.headers.get('x-hushh-api-key') === ingestToken);
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
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-admin-token,x-hushh-api-key',
  };
}
