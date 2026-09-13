import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { hash, secret } from './store.mjs';
import { driveScope } from './google.mjs';

const DAY = 86400000;
class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}
const reject = (status, code) => {
  throw new HttpError(status, code);
};
const text = (value, max = 16384) => typeof value === 'string' && value.length > 0 && value.length <= max;

/** Auth and refresh only. No book, metadata, Drive proxy or general-purpose upstream endpoint. */
export function createAuthServer({ config, store, google, now = Date.now }) {
  const db = store.db;
  const access = new Map();
  const inflight = new Map();
  const rates = new Map();
  const origins = new Set(config.origins);
  const view = (session) => ({
    identity: { subject: session.subject, label: session.label, expiresAt: session.expires },
    driveReady: Boolean(session.refresh),
  });
  function sessionFor(token) {
    if (!text(token, 128)) reject(401, 'session_expired');
    const session = db
      .prepare('SELECT * FROM sessions WHERE id = ? AND expires > ? AND deadline > ?')
      .get(hash(token), now(), now());
    if (!session) reject(401, 'session_expired');
    return session;
  }
  async function refresh(session) {
    if (!session.refresh) reject(409, 'drive_reconnect');
    const cached = access.get(session.id);
    if (cached && cached.expiresAt > now() + 60000) return cached;
    if (inflight.has(session.id)) return inflight.get(session.id);
    const task = (async () => {
      try {
        const value = await google.refresh(store.unseal(session.refresh, session.id));
        const current = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires > ?').get(session.id, now());
        if (!current || current.refresh !== session.refresh) reject(401, 'session_changed');
        if (value.refreshToken)
          db.prepare('UPDATE sessions SET refresh = ? WHERE id = ?').run(
            store.seal(value.refreshToken, session.id),
            session.id,
          );
        const result = { accessToken: value.accessToken, expiresAt: now() + Math.min(value.expiresIn, 3600) * 1000 };
        access.set(session.id, result);
        return result;
      } catch (error) {
        if (error.reconnect) {
          db.prepare('UPDATE sessions SET refresh = NULL WHERE id = ? AND refresh = ?').run(
            session.id,
            session.refresh,
          );
          access.delete(session.id);
          reject(409, 'drive_reconnect');
        }
        throw error;
      }
    })().finally(() => inflight.delete(session.id));
    inflight.set(session.id, task);
    return task;
  }
  async function callback(url, response) {
    const state = url.searchParams.get('state');
    const flow =
      text(state, 128) &&
      db.prepare("SELECT * FROM flows WHERE id = ? AND status = 'pending' AND expires > ?").get(hash(state), now());
    if (!flow) reject(400, 'invalid_oauth_state');
    db.prepare("UPDATE flows SET status = 'processing' WHERE id = ?").run(flow.id);
    let status = 'failed';
    try {
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || !text(code)) reject(400, 'google_denied');
      const grant = await google.exchange(code, flow.verifier, flow.nonce);
      const session = db
        .prepare('SELECT * FROM sessions WHERE id = ? AND expires > ? AND deadline > ?')
        .get(flow.session, now(), now());
      if (!session || session.subject !== grant.identity.subject) reject(409, 'account_mismatch');
      // A disconnect/logout while Google was open cancels this flow.
      if (!db.prepare("SELECT id FROM flows WHERE id = ? AND status = 'processing'").get(flow.id))
        reject(409, 'cancelled');
      db.prepare('UPDATE sessions SET refresh = ? WHERE id = ?').run(
        store.seal(grant.refreshToken, session.id),
        session.id,
      );
      access.set(session.id, {
        accessToken: grant.accessToken,
        expiresAt: now() + Math.min(grant.expiresIn, 3600) * 1000,
      });
      status = 'connected';
    } catch {
      /* Never render Google's responses, codes or credentials. */
    }
    db.prepare('UPDATE flows SET status = ?, verifier = ?, nonce = ? WHERE id = ?').run(status, '', '', flow.id);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    });
    response.end(
      `<!doctype html><html lang="ko"><meta charset="utf-8"><title>모야 Google 연결</title><body><p>${status === 'connected' ? '연결됐습니다. 이 창을 닫고 모야로 돌아가세요.' : '연결을 완료하지 못했습니다. 모야로 돌아가 다시 시도하세요.'}</p></body></html>`,
    );
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Vary', 'Origin');
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      if ((request.url?.length ?? 0) > 20000) reject(414, 'request_too_large');
      const url = new URL(request.url, config.publicUrl);
      const origin = request.headers.origin;
      if (url.pathname === '/health' && request.method === 'GET') return json(200, { ok: true });
      const ip = request.socket.remoteAddress;
      const bucket = rates.get(ip) ?? { count: 0, until: now() + 60000 };
      if (bucket.until <= now()) {
        bucket.count = 0;
        bucket.until = now() + 60000;
      }
      if (++bucket.count > 120) reject(429, 'rate_limited');
      rates.set(ip, bucket);
      if (url.pathname === '/oauth/callback' && request.method === 'GET') return await callback(url, response);
      if (!origins.has(origin)) reject(403, 'origin_denied');
      response.setHeader('Access-Control-Allow-Origin', origin);
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'POST');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Moya-Auth');
        response.writeHead(204).end();
        return;
      }
      if (
        request.method !== 'POST' ||
        request.headers['x-moya-auth'] !== '1' ||
        !request.headers['content-type']?.startsWith('application/json')
      )
        reject(400, 'invalid_request');
      let length = 0;
      const chunks = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 32768) reject(413, 'request_too_large');
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(400, 'invalid_json');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) reject(400, 'invalid_json');
      if (url.pathname === '/challenge') {
        const nonce = secret();
        db.prepare('INSERT INTO challenges VALUES (?, ?, ?)').run(hash(nonce), origin, now() + 300000);
        return json(200, { nonce });
      }
      if (url.pathname === '/login') {
        if (!text(body.nonce, 128) || !text(body.credential)) reject(400, 'invalid_login');
        const challenge = db
          .prepare('DELETE FROM challenges WHERE id = ? AND origin = ? AND expires > ? RETURNING id')
          .get(hash(body.nonce), origin, now());
        if (!challenge) reject(400, 'invalid_challenge');
        const identity = await google.verify(body.credential, body.nonce);
        const token = secret();
        const expires = now() + 30 * DAY;
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL)').run(
          hash(token),
          identity.subject,
          identity.label,
          expires,
          now() + 180 * DAY,
        );
        return json(200, { token, identity: { ...identity, expiresAt: expires }, driveReady: false });
      }
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      const session = sessionFor(token);
      if (url.pathname === '/session') {
        session.expires = Math.min(now() + 30 * DAY, session.deadline);
        db.prepare('UPDATE sessions SET expires = ? WHERE id = ?').run(session.expires, session.id);
        return json(200, view(session));
      }
      if (url.pathname === '/logout' || url.pathname === '/drive/disconnect') {
        db.prepare('DELETE FROM flows WHERE session = ?').run(session.id);
        if (url.pathname === '/logout') db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
        else db.prepare('UPDATE sessions SET refresh = NULL WHERE id = ?').run(session.id);
        access.delete(session.id);
        return json(200, { ok: true });
      }
      if (url.pathname === '/drive/start') {
        db.prepare('DELETE FROM flows WHERE session = ?').run(session.id);
        const state = secret(),
          verifier = secret(),
          nonce = secret();
        db.prepare('INSERT INTO flows VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          hash(state),
          session.id,
          origin,
          verifier,
          nonce,
          now() + 300000,
          'pending',
        );
        const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authorize.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: `${config.publicUrl}/oauth/callback`,
          response_type: 'code',
          scope: `openid email profile ${driveScope}`,
          access_type: 'offline',
          prompt: 'consent',
          include_granted_scopes: 'false',
          login_hint: session.subject,
          state,
          nonce,
          code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        }).toString();
        return json(200, { flow: state, url: authorize.href });
      }
      if (url.pathname === '/drive/status') {
        if (!text(body.flow, 128)) reject(400, 'invalid_flow');
        const flow = db
          .prepare('SELECT status FROM flows WHERE id = ? AND session = ? AND expires > ?')
          .get(hash(body.flow), session.id, now());
        return json(200, { status: flow?.status ?? 'failed' });
      }
      if (url.pathname === '/drive/token') {
        if (body.accountId !== session.subject) reject(409, 'account_mismatch');
        if (body.forceRefresh === true) access.delete(session.id);
        return json(200, await refresh(session));
      }
      reject(404, 'not_found');
    } catch (error) {
      json(error.status ?? 502, { error: error.status ? error.message : 'auth_service_unavailable' });
    }
  });
  const timer = setInterval(() => {
    store.prune(now());
    for (const [key, value] of rates) if (value.until <= now()) rates.delete(key);
    for (const [key, value] of access) if (value.expiresAt <= now()) access.delete(key);
  }, 60000).unref();
  server.on('close', () => clearInterval(timer));
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
