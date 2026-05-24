import { getStore } from '@netlify/blobs';

const STORE_NAME = 'hushh-login-events';
const EVENTS_KEY = 'events.json';
const USERS_KEY = 'users.json';
const MAX_RECENT_LOGINS_PER_USER = 25;
const MAX_RECENT_FILES_PER_USER = 25;
const MAX_RECENT_FAILURES_PER_USER = 25;

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    if (request.method === 'GET') {
      return handleList(request);
    }

    if (request.method === 'POST') {
      return handleCreate(request);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    return json(
      { error: error.statusCode ? error.message : 'Internal server error' },
      error.statusCode || 500
    );
  }
};

async function handleList(request) {
  if (!isAdminAuthorized(request)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const users = await readUsers();
  return json({
    users,
    ...summarizeUsers(users),
  });
}

async function handleCreate(request) {
  if (!isIngestAuthorized(request)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const payload = await request.json().catch(() => ({}));
  const event = createAdminEvent(payload);
  const users = await readUsers();
  const nextUsers = upsertUserEvent(users, event);
  await writeUsers(nextUsers);

  return json({ ok: true, user: nextUsers.find(user => user.email === event.email) }, 201);
}

async function readUsers() {
  const store = getStore(STORE_NAME);
  const users = await store.get(USERS_KEY, { type: 'json' });

  if (Array.isArray(users)) {
    return normalizeUsers(users);
  }

  const legacyEvents = await readEvents();
  const migratedUsers = buildUsersFromEvents(legacyEvents);
  if (migratedUsers.length) {
    await writeUsers(migratedUsers);
  }

  return migratedUsers;
}

async function writeUsers(users) {
  const store = getStore(STORE_NAME);
  await store.setJSON(USERS_KEY, normalizeUsers(users));
}

async function readEvents() {
  const store = getStore(STORE_NAME);
  const events = await store.get(EVENTS_KEY, { type: 'json' });
  return Array.isArray(events) ? events : [];
}

function summarizeUsers(users) {
  return {
    totalLogins: users.reduce((total, user) => total + user.loginCount, 0),
    uniqueEmails: users.length,
    latestLoginAt: users[0]?.latestLoginAt || null,
    latestActiveAt: users[0]?.latestActiveAt || users[0]?.latestLoginAt || null,
    totalFilesUploaded: users.reduce((total, user) => total + user.filesUploaded, 0),
    totalSessions: users.reduce((total, user) => total + user.sessionCount, 0),
    totalFailures: users.reduce((total, user) => total + user.failedFiles, 0),
    totalCreditsUsed: roundCredits(users.reduce((total, user) => total + user.creditsUsed, 0)),
  };
}

function createAdminEvent(payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throwHttpError(400, 'Valid email is required');
  }

  const eventType = normalizeEventType(payload.eventType);
  const deviceInfo = normalizeDeviceInfo(payload.deviceInfo);
  const receivedAt = new Date().toISOString();

  return {
    id: safeString(payload.id) || crypto.randomUUID(),
    eventType,
    email,
    provider: payload.provider === 'google' ? 'google' : 'google',
    authMethod: payload.authMethod === 'manual' ? 'manual' : 'oauth',
    uid: safeString(payload.uid),
    displayName: safeString(payload.displayName),
    photoUrl: safeString(payload.photoUrl),
    signedInAt: safeString(payload.signedInAt) || receivedAt,
    activeAt: safeString(payload.activeAt) || receivedAt,
    receivedAt,
    country: safeString(payload.country) || deviceInfo.country,
    deviceInfo,
    session: normalizeFileSession(payload.session || payload.fileSession || payload.file),
  };
}

function normalizeEventType(value) {
  if (value === 'activity' || value === 'file_session') return value;
  return 'login';
}

function buildUsersFromEvents(events) {
  return events
    .slice()
    .reverse()
    .reduce((users, event) => upsertUserEvent(users, createAdminEvent(event)), []);
}

function upsertUserEvent(users, event) {
  const normalized = normalizeUsers(users);
  const index = normalized.findIndex(user => user.email === event.email);
  const existing = index >= 0 ? normalized[index] : createEmptyUser(event.email);
  const baseUser = {
    ...existing,
    displayName: event.displayName || existing.displayName,
    photoUrl: event.photoUrl || existing.photoUrl,
    uid: event.uid || existing.uid,
    provider: event.provider || existing.provider,
    authMethod: event.authMethod || existing.authMethod,
    country: event.country || existing.country,
    deviceInfo: event.deviceInfo || existing.deviceInfo,
    latestActiveAt: latestDate(existing.latestActiveAt, event.activeAt || event.signedInAt || event.receivedAt),
    latestReceivedAt: latestDate(existing.latestReceivedAt, event.receivedAt),
  };

  let user = baseUser;

  if (event.eventType === 'login') {
    user = applyLogin(user, event);
  }

  if (event.eventType === 'file_session' && event.session) {
    user = applyFileSession(user, event);
  }

  if (index >= 0) {
    normalized[index] = user;
  } else {
    normalized.push(user);
  }

  return normalizeUsers(normalized);
}

function applyLogin(user, event) {
  const login = toLoginEntry(event);
  const recentLogins = [login, ...user.recentLogins.filter(item => item.id !== login.id)]
    .sort((a, b) => compareDatesDesc(a.signedInAt, b.signedInAt))
    .slice(0, MAX_RECENT_LOGINS_PER_USER);

  return {
    ...user,
    loginCount: user.loginCount + 1,
    signupAt: earliestDate(user.signupAt, event.signedInAt),
    firstLoginAt: earliestDate(user.firstLoginAt, event.signedInAt),
    latestLoginAt: latestDate(user.latestLoginAt, event.signedInAt),
    recentLogins,
  };
}

function applyFileSession(user, event) {
  const session = {
    ...event.session,
    receivedAt: event.receivedAt,
    deviceLabel: deviceLabel(event.deviceInfo),
  };
  const sessionId = session.sessionId;
  const existingIndex = user.recentFiles.findIndex(file => file.sessionId === sessionId);
  const existingSession = existingIndex >= 0 ? user.recentFiles[existingIndex] : null;
  const nextSession = {
    ...existingSession,
    ...session,
    status: session.status || existingSession?.status || 'started',
    updatedAt: event.receivedAt,
  };
  const recentFiles = existingIndex >= 0
    ? user.recentFiles.map((file, index) => index === existingIndex ? nextSession : file)
    : [nextSession, ...user.recentFiles];

  const isNewSession = !existingSession;
  const processedNow = nextSession.status === 'processed' && existingSession?.status !== 'processed';
  const failedNow = nextSession.status === 'failed' && existingSession?.status !== 'failed';
  const credits = processedNow ? estimateCredits(nextSession.durationSeconds) : 0;

  return {
    ...user,
    sessionCount: user.sessionCount + (isNewSession ? 1 : 0),
    filesUploaded: user.filesUploaded + (isNewSession ? 1 : 0),
    audioFiles: user.audioFiles + (isNewSession && nextSession.fileType === 'audio' ? 1 : 0),
    videoFiles: user.videoFiles + (isNewSession && nextSession.fileType === 'video' ? 1 : 0),
    processedFiles: user.processedFiles + (processedNow ? 1 : 0),
    failedFiles: user.failedFiles + (failedNow ? 1 : 0),
    totalDurationSeconds: user.totalDurationSeconds + (isNewSession ? nextSession.durationSeconds : 0),
    creditsUsed: roundCredits(user.creditsUsed + credits),
    recentFiles: recentFiles
      .sort((a, b) => compareDatesDesc(a.updatedAt || a.startedAt, b.updatedAt || b.startedAt))
      .slice(0, MAX_RECENT_FILES_PER_USER),
    recentFailures: failedNow
      ? [toFailureEntry(event, nextSession), ...user.recentFailures].slice(0, MAX_RECENT_FAILURES_PER_USER)
      : user.recentFailures,
    failureDevices: failedNow
      ? upsertFailureDevice(user.failureDevices, event.deviceInfo, nextSession.errorMessage)
      : user.failureDevices,
  };
}

function normalizeUsers(users) {
  return users
    .map(user => {
      const email = String(user.email || '').trim().toLowerCase();
      if (!email) return null;

      const recentLogins = Array.isArray(user.recentLogins)
        ? user.recentLogins.map(toLoginEntry).filter(Boolean)
        : [];
      const recentFiles = Array.isArray(user.recentFiles)
        ? user.recentFiles.map(normalizeStoredFileSession).filter(Boolean)
        : [];
      const recentFailures = Array.isArray(user.recentFailures)
        ? user.recentFailures.map(normalizeFailureEntry).filter(Boolean)
        : [];
      const failureDevices = Array.isArray(user.failureDevices)
        ? user.failureDevices.map(normalizeFailureDevice).filter(Boolean)
        : [];

      return {
        email,
        displayName: safeString(user.displayName),
        photoUrl: safeString(user.photoUrl),
        uid: safeString(user.uid),
        provider: user.provider === 'google' ? 'google' : 'google',
        authMethod: user.authMethod === 'manual' ? 'manual' : 'oauth',
        country: safeString(user.country) || user.deviceInfo?.country || null,
        deviceInfo: normalizeDeviceInfo(user.deviceInfo),
        loginCount: Math.max(Number(user.loginCount) || recentLogins.length || 0, recentLogins.length),
        signupAt: safeString(user.signupAt) || safeString(user.firstLoginAt) || recentLogins.at(-1)?.signedInAt || null,
        firstLoginAt: safeString(user.firstLoginAt) || recentLogins.at(-1)?.signedInAt || null,
        latestLoginAt: safeString(user.latestLoginAt) || recentLogins[0]?.signedInAt || null,
        latestActiveAt: safeString(user.latestActiveAt) || safeString(user.latestLoginAt) || recentLogins[0]?.signedInAt || null,
        latestReceivedAt: safeString(user.latestReceivedAt) || recentLogins[0]?.receivedAt || null,
        sessionCount: Number(user.sessionCount) || recentFiles.length || 0,
        filesUploaded: Number(user.filesUploaded) || recentFiles.length || 0,
        audioFiles: Number(user.audioFiles) || recentFiles.filter(file => file.fileType === 'audio').length || 0,
        videoFiles: Number(user.videoFiles) || recentFiles.filter(file => file.fileType === 'video').length || 0,
        processedFiles: Number(user.processedFiles) || recentFiles.filter(file => file.status === 'processed').length || 0,
        failedFiles: Number(user.failedFiles) || recentFiles.filter(file => file.status === 'failed').length || 0,
        totalDurationSeconds: Number(user.totalDurationSeconds) || recentFiles.reduce((sum, file) => sum + file.durationSeconds, 0),
        creditsUsed: roundCredits(Number(user.creditsUsed) || 0),
        recentLogins: recentLogins
          .sort((a, b) => compareDatesDesc(a.signedInAt, b.signedInAt))
          .slice(0, MAX_RECENT_LOGINS_PER_USER),
        recentFiles: recentFiles
          .sort((a, b) => compareDatesDesc(a.updatedAt || a.startedAt, b.updatedAt || b.startedAt))
          .slice(0, MAX_RECENT_FILES_PER_USER),
        recentFailures: recentFailures
          .sort((a, b) => compareDatesDesc(a.failedAt, b.failedAt))
          .slice(0, MAX_RECENT_FAILURES_PER_USER),
        failureDevices: failureDevices.sort((a, b) => b.count - a.count),
      };
    })
    .filter(Boolean)
    .sort((a, b) => compareDatesDesc(a.latestActiveAt || a.latestLoginAt, b.latestActiveAt || b.latestLoginAt));
}

function createEmptyUser(email) {
  return {
    email,
    displayName: null,
    photoUrl: null,
    uid: null,
    provider: 'google',
    authMethod: 'oauth',
    country: null,
    deviceInfo: null,
    loginCount: 0,
    signupAt: null,
    firstLoginAt: null,
    latestLoginAt: null,
    latestActiveAt: null,
    latestReceivedAt: null,
    sessionCount: 0,
    filesUploaded: 0,
    audioFiles: 0,
    videoFiles: 0,
    processedFiles: 0,
    failedFiles: 0,
    totalDurationSeconds: 0,
    creditsUsed: 0,
    recentLogins: [],
    recentFiles: [],
    recentFailures: [],
    failureDevices: [],
  };
}

function normalizeDeviceInfo(value) {
  if (!value || typeof value !== 'object') return null;

  return {
    platform: safeString(value.platform),
    osVersion: safeString(value.osVersion),
    deviceName: safeString(value.deviceName),
    appVersion: safeString(value.appVersion),
    locale: safeString(value.locale),
    timezone: safeString(value.timezone),
    country: safeString(value.country),
  };
}

function normalizeFileSession(value) {
  if (!value || typeof value !== 'object') return null;
  const now = new Date().toISOString();

  return {
    sessionId: safeString(value.sessionId) || crypto.randomUUID(),
    status: normalizeSessionStatus(value.status),
    fileName: safeString(value.fileName),
    fileType: value.fileType === 'video' ? 'video' : 'audio',
    mimeType: safeString(value.mimeType),
    outputFormat: safeString(value.outputFormat),
    durationSeconds: Math.max(0, Number(value.durationSeconds) || 0),
    sizeBytes: Math.max(0, Number(value.sizeBytes) || 0),
    startedAt: safeString(value.startedAt) || now,
    processedAt: safeString(value.processedAt),
    failedAt: safeString(value.failedAt),
    errorMessage: safeString(value.errorMessage),
  };
}

function normalizeStoredFileSession(value) {
  const session = normalizeFileSession(value);
  if (!session) return null;

  return {
    ...session,
    receivedAt: safeString(value.receivedAt),
    updatedAt: safeString(value.updatedAt) || safeString(value.receivedAt) || session.startedAt,
    deviceLabel: safeString(value.deviceLabel),
  };
}

function normalizeSessionStatus(value) {
  if (value === 'processed' || value === 'failed') return value;
  return 'started';
}

function toLoginEntry(event) {
  if (!event) return null;

  return {
    id: safeString(event.id) || crypto.randomUUID(),
    authMethod: event.authMethod === 'manual' ? 'manual' : 'oauth',
    signedInAt: safeString(event.signedInAt) || new Date().toISOString(),
    receivedAt: safeString(event.receivedAt) || new Date().toISOString(),
    deviceLabel: event.deviceInfo ? deviceLabel(event.deviceInfo) : safeString(event.deviceLabel),
  };
}

function toFailureEntry(event, session) {
  return {
    id: crypto.randomUUID(),
    fileName: session.fileName,
    fileType: session.fileType,
    errorMessage: session.errorMessage || 'Processing failed',
    failedAt: session.failedAt || event.receivedAt,
    deviceLabel: deviceLabel(event.deviceInfo),
  };
}

function normalizeFailureEntry(value) {
  if (!value || typeof value !== 'object') return null;

  return {
    id: safeString(value.id) || crypto.randomUUID(),
    fileName: safeString(value.fileName),
    fileType: value.fileType === 'video' ? 'video' : 'audio',
    errorMessage: safeString(value.errorMessage) || 'Processing failed',
    failedAt: safeString(value.failedAt) || new Date().toISOString(),
    deviceLabel: safeString(value.deviceLabel),
  };
}

function upsertFailureDevice(devices, deviceInfo, errorMessage) {
  const normalized = Array.isArray(devices) ? devices.map(normalizeFailureDevice).filter(Boolean) : [];
  const label = deviceLabel(deviceInfo);
  const index = normalized.findIndex(device => device.label === label);
  const next = index >= 0 ? normalized[index] : { label, count: 0, latestAt: null, lastError: null };

  next.count += 1;
  next.latestAt = new Date().toISOString();
  next.lastError = safeString(errorMessage) || 'Processing failed';

  if (index >= 0) {
    normalized[index] = next;
  } else {
    normalized.push(next);
  }

  return normalized;
}

function normalizeFailureDevice(value) {
  if (!value || typeof value !== 'object') return null;

  return {
    label: safeString(value.label) || 'Unknown device',
    count: Number(value.count) || 0,
    latestAt: safeString(value.latestAt),
    lastError: safeString(value.lastError),
  };
}

function deviceLabel(deviceInfo) {
  if (!deviceInfo) return 'Unknown device';
  return [deviceInfo.platform, deviceInfo.osVersion].filter(Boolean).join(' ') || 'Unknown device';
}

function estimateCredits(durationSeconds) {
  if (!durationSeconds) return 0;
  return roundCredits(Math.max(0.01, durationSeconds / 60));
}

function roundCredits(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
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

function isAdminAuthorized(request) {
  const url = new URL(request.url);
  const adminToken = process.env.HUSHH_ADMIN_TOKEN;
  const headerToken = request.headers.get('x-admin-token');
  const queryToken = url.searchParams.get('token');
  return Boolean(adminToken && (headerToken === adminToken || queryToken === adminToken));
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
