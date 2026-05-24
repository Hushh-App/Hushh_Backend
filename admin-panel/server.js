const crypto = require('crypto');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.PORT || 4310);
const ADMIN_TOKEN = process.env.HUSHH_ADMIN_TOKEN || 'dev-admin-token';
const INGEST_TOKEN = process.env.HUSHH_INGEST_TOKEN || 'dev-ingest-token';
const DATA_DIR = process.env.HUSHH_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'login-events.json');
const USERS_FILE = path.join(DATA_DIR, 'login-users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const CONTACT_FILE = path.join(__dirname, 'contact.html');
const PRIVACY_FILE = path.join(__dirname, 'privacy.html');
const TERMS_FILE = path.join(__dirname, 'terms.html');
const MAX_RECENT_LOGINS_PER_USER = 25;
const DEFAULT_SETTINGS = {
  contactUrl: 'https://calendly.com/contact-hushhapp/30min',
  updatedAt: null,
};

const server = http.createServer(async (req, res) => {
  try {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url || '/', true);

    if (req.method === 'GET' && parsedUrl.pathname === '/') {
      await sendFile(res, INDEX_FILE, 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && (parsedUrl.pathname === '/contact' || parsedUrl.pathname === '/contact.html')) {
      await sendFile(res, CONTACT_FILE, 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && (parsedUrl.pathname === '/privacy' || parsedUrl.pathname === '/privacy.html')) {
      await sendFile(res, PRIVACY_FILE, 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && (parsedUrl.pathname === '/terms' || parsedUrl.pathname === '/terms.html')) {
      await sendFile(res, TERMS_FILE, 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/api/settings') {
      sendJson(res, 200, await readSettings());
      return;
    }

    if (req.method === 'PUT' && parsedUrl.pathname === '/api/settings') {
      if (!isAdminAuthorized(req, parsedUrl.query)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const payload = await readJsonBody(req);
      sendJson(res, 200, await writeSettings(payload));
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/api/login-events') {
      if (!isAdminAuthorized(req, parsedUrl.query)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const users = await readUsers();
      const totalLogins = users.reduce((total, user) => total + user.loginCount, 0);
      sendJson(res, 200, {
        users,
        totalLogins,
        uniqueEmails: users.length,
        latestLoginAt: users[0]?.latestLoginAt || null,
      });
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/login-events') {
      if (!isIngestAuthorized(req)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const payload = await readJsonBody(req);
      const event = createLoginEvent(payload);
      const users = await readUsers();
      const nextUsers = upsertUserLogin(users, event);
      await writeUsers(nextUsers);
      sendJson(res, 201, { ok: true, user: nextUsers.find(user => user.email === event.email) });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, {
      error: error.statusCode ? error.message : 'Internal server error',
    });
  }
});

server.listen(PORT, () => {
  console.log(`Hushh admin panel running at http://localhost:${PORT}`);
});

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-admin-token,x-hushh-api-key');
}

function isAdminAuthorized(req, query) {
  const headerToken = req.headers['x-admin-token'];
  const queryToken = query.token;
  return headerToken === ADMIN_TOKEN || queryToken === ADMIN_TOKEN;
}

function isIngestAuthorized(req) {
  return req.headers['x-hushh-api-key'] === INGEST_TOKEN;
}

async function readEvents() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const events = JSON.parse(raw);
    return Array.isArray(events) ? events : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readUsers() {
  try {
    const raw = await fs.readFile(USERS_FILE, 'utf8');
    const users = JSON.parse(raw);
    return Array.isArray(users) ? normalizeUsers(users) : [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const legacyEvents = await readEvents();
  const migratedUsers = buildUsersFromEvents(legacyEvents);
  if (migratedUsers.length) {
    await writeUsers(migratedUsers);
  }

  return migratedUsers;
}

async function writeUsers(users) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(USERS_FILE, JSON.stringify(normalizeUsers(users), null, 2));
}

async function readSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_SETTINGS;
    throw error;
  }
}

async function writeSettings(payload) {
  const settings = normalizeSettings({
    ...await readSettings(),
    contactUrl: payload.contactUrl,
    updatedAt: new Date().toISOString(),
  });

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

function createLoginEvent(payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throwHttpError(400, 'Valid email is required');
  }

  return {
    id: payload.id || crypto.randomUUID(),
    email,
    provider: payload.provider === 'google' ? 'google' : 'google',
    authMethod: payload.authMethod === 'manual' ? 'manual' : 'oauth',
    uid: safeString(payload.uid),
    displayName: safeString(payload.displayName),
    photoUrl: safeString(payload.photoUrl),
    signedInAt: payload.signedInAt || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  };
}

function buildUsersFromEvents(events) {
  return events
    .slice()
    .reverse()
    .reduce((users, event) => upsertUserLogin(users, event), []);
}

function upsertUserLogin(users, event) {
  const normalized = normalizeUsers(users);
  const index = normalized.findIndex(user => user.email === event.email);
  const existing = index >= 0 ? normalized[index] : createEmptyUser(event.email);
  const login = toLoginEntry(event);
  const recentLogins = [login, ...existing.recentLogins.filter(item => item.id !== login.id)]
    .sort((a, b) => compareDatesDesc(a.signedInAt, b.signedInAt))
    .slice(0, MAX_RECENT_LOGINS_PER_USER);

  const user = {
    ...existing,
    displayName: event.displayName || existing.displayName,
    photoUrl: event.photoUrl || existing.photoUrl,
    uid: event.uid || existing.uid,
    provider: event.provider || existing.provider,
    authMethod: event.authMethod || existing.authMethod,
    loginCount: existing.loginCount + 1,
    firstLoginAt: earliestDate(existing.firstLoginAt, event.signedInAt),
    latestLoginAt: latestDate(existing.latestLoginAt, event.signedInAt),
    latestReceivedAt: latestDate(existing.latestReceivedAt, event.receivedAt),
    recentLogins,
  };

  if (index >= 0) {
    normalized[index] = user;
  } else {
    normalized.push(user);
  }

  return normalizeUsers(normalized);
}

function normalizeUsers(users) {
  return users
    .map(user => {
      const email = String(user.email || '').trim().toLowerCase();
      if (!email) return null;

      const recentLogins = Array.isArray(user.recentLogins)
        ? user.recentLogins.map(toLoginEntry).filter(Boolean)
        : [];

      return {
        email,
        displayName: safeString(user.displayName),
        photoUrl: safeString(user.photoUrl),
        uid: safeString(user.uid),
        provider: user.provider === 'google' ? 'google' : 'google',
        authMethod: user.authMethod === 'manual' ? 'manual' : 'oauth',
        loginCount: Math.max(Number(user.loginCount) || recentLogins.length || 0, recentLogins.length),
        firstLoginAt: safeString(user.firstLoginAt) || recentLogins.at(-1)?.signedInAt || null,
        latestLoginAt: safeString(user.latestLoginAt) || recentLogins[0]?.signedInAt || null,
        latestReceivedAt: safeString(user.latestReceivedAt) || recentLogins[0]?.receivedAt || null,
        recentLogins: recentLogins
          .sort((a, b) => compareDatesDesc(a.signedInAt, b.signedInAt))
          .slice(0, MAX_RECENT_LOGINS_PER_USER),
      };
    })
    .filter(Boolean)
    .sort((a, b) => compareDatesDesc(a.latestLoginAt, b.latestLoginAt));
}

function createEmptyUser(email) {
  return {
    email,
    displayName: null,
    photoUrl: null,
    uid: null,
    provider: 'google',
    authMethod: 'oauth',
    loginCount: 0,
    firstLoginAt: null,
    latestLoginAt: null,
    latestReceivedAt: null,
    recentLogins: [],
  };
}

function toLoginEntry(event) {
  if (!event) return null;

  return {
    id: safeString(event.id) || crypto.randomUUID(),
    authMethod: event.authMethod === 'manual' ? 'manual' : 'oauth',
    signedInAt: safeString(event.signedInAt) || new Date().toISOString(),
    receivedAt: safeString(event.receivedAt) || new Date().toISOString(),
  };
}

function compareDatesDesc(left, right) {
  return dateValue(right) - dateValue(left);
}

function earliestDate(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return dateValue(left) <= dateValue(right) ? left : right;
}

function latestDate(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return dateValue(left) >= dateValue(right) ? left : right;
}

function dateValue(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
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
    const parsedUrl = new URL(trimmed);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throwHttpError(400, 'Contact link must start with http:// or https://');
    }

    return parsedUrl.toString();
  } catch (error) {
    if (error.statusCode) throw error;
    throwHttpError(400, 'Enter a valid contact link.');
  }
}

function safeString(value) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, 500);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throwHttpError(413, 'Body too large');
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function sendFile(res, filePath, contentType) {
  const content = await fs.readFile(filePath);
  res.writeHead(200, { 'content-type': contentType });
  res.end(content);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function throwHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}
