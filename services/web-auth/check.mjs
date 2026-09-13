import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeyPair, SignJWT } from 'jose';
import { AuthStore } from './store.mjs';
import { createAuthServer } from './app.mjs';
import { googleProvider, GoogleGrantError } from './google.mjs';

const origin = 'http://localhost:1422';
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'moya-auth-'));
  const path = join(folder, 'auth.sqlite');
  const key = randomBytes(32).toString('base64');
  let time = Date.now(),
    refreshCount = 0,
    refreshError;
  let exchangeSubject = 'reader',
    hold;
  const google = {
    verify: async (token) => {
      assert.equal(token, 'signed-fixture');
      return { subject: 'reader', label: 'Reader' };
    },
    exchange: async () => {
      if (hold) await hold;
      return {
        identity: { subject: exchangeSubject },
        refreshToken: 'sensitive-refresh',
        accessToken: 'first-access',
        expiresIn: 3600,
      };
    },
    refresh: async (token) => {
      assert.equal(token, 'sensitive-refresh');
      refreshCount += 1;
      if (refreshError) throw refreshError;
      return { accessToken: `renewed-${refreshCount}`, expiresIn: 3600 };
    },
  };
  let store, server, base;
  async function start() {
    store = new AuthStore(path, key);
    server = createAuthServer({
      config: { clientId: 'client', origins: [origin], publicUrl: 'http://localhost:1432' },
      store,
      google,
      now: () => time,
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    await new Promise((done) => server.close(done));
    store.close();
  }
  await start();
  async function post(path, body = {}, token, extra = {}) {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Moya-Auth': '1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function login() {
    const challenge = await post('/challenge');
    const result = await post('/login', { nonce: challenge.body.nonce, credential: 'signed-fixture' });
    assert.equal(result.status, 200);
    return result.body.token;
  }
  async function begin(token) {
    const result = await post('/drive/start', {}, token);
    assert.equal(result.status, 200);
    const url = new URL(result.body.url);
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    return result.body.flow;
  }
  const callback = (flow) => fetch(`${base}/oauth/callback?state=${flow}&code=one-time-code`);
  return {
    post,
    login,
    begin,
    callback,
    store: () => store,
    advance: (ms) => {
      time += ms;
    },
    setSubject: (sub) => {
      exchangeSubject = sub;
    },
    setHold: (value) => {
      hold = value;
    },
    setRefreshError: (error) => {
      refreshError = error;
    },
    refreshCount: () => refreshCount,
    restart: async () => {
      await stop();
      await start();
    },
    close: async () => {
      await stop();
      if (
        !resolve(folder).startsWith(resolve(tmpdir()) + '\\moya-auth-') &&
        !resolve(folder).startsWith(resolve(tmpdir()) + '/moya-auth-')
      )
        throw new Error('Unexpected test path');
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test('persists only hashed sessions/encrypted refresh grants; restart and expiry renew without login', async () => {
  const f = await fixture();
  try {
    const token = await f.login();
    assert.equal((await f.post('/session', {}, token)).body.driveReady, false);
    const flow = await f.begin(token);
    assert.equal((await f.callback(flow)).status, 200);
    const row = f.store().db.prepare('SELECT * FROM sessions').get();
    assert.notEqual(row.id, token);
    assert.ok(!row.refresh.includes('sensitive-refresh'));
    assert.throws(() => f.store().unseal(row.refresh, 'another-session'));
    assert.equal((await f.post('/drive/token', { accountId: 'reader' }, token)).body.accessToken, 'first-access');
    assert.equal((await f.post('/drive/token', { accountId: 'different' }, token)).status, 409);
    await f.restart();
    assert.equal((await f.post('/session', {}, token)).body.driveReady, true);
    const renewed = await Promise.all([
      f.post('/drive/token', { accountId: 'reader' }, token),
      f.post('/drive/token', { accountId: 'reader' }, token),
    ]);
    assert.equal(renewed[0].body.accessToken, 'renewed-1');
    assert.equal(renewed[1].body.accessToken, 'renewed-1');
    assert.equal(f.refreshCount(), 1);
    f.advance(3600000);
    assert.equal((await f.post('/drive/token', { accountId: 'reader' }, token)).body.accessToken, 'renewed-2');
    await f.post('/logout', {}, token);
    assert.equal((await f.post('/session', {}, token)).status, 401);
    assert.equal(f.store().db.prepare('SELECT count(*) AS total FROM sessions').get().total, 0);
  } finally {
    await f.close();
  }
});

test('rejects foreign origins, challenge/state replay, account mismatch and late callback after disconnect', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('/challenge', {}, undefined, { Origin: 'https://attacker.test' })).status, 403);
    assert.equal((await f.post('/challenge', {}, undefined, { 'X-Moya-Auth': '' })).status, 400);
    const challenge = (await f.post('/challenge')).body.nonce;
    assert.equal((await f.post('/login', { nonce: challenge, credential: 'signed-fixture' })).status, 200);
    assert.equal((await f.post('/login', { nonce: challenge, credential: 'signed-fixture' })).status, 400);
    const token = await f.login();
    let flow = await f.begin(token);
    f.setSubject('other');
    await f.callback(flow);
    assert.equal((await f.post('/drive/status', { flow }, token)).body.status, 'failed');
    assert.equal((await f.callback(flow)).status, 400);
    f.setSubject('reader');
    flow = await f.begin(token);
    let release;
    f.setHold(
      new Promise((done) => {
        release = done;
      }),
    );
    const pending = f.callback(flow);
    await new Promise((done) => setTimeout(done, 30));
    await f.post('/drive/disconnect', {}, token);
    release();
    await pending;
    assert.equal((await f.post('/session', {}, token)).body.driveReady, false);
  } finally {
    await f.close();
  }
});

test('temporary upstream failure keeps grant; revoked grant requires reconnect; idle session expires', async () => {
  const f = await fixture();
  try {
    const token = await f.login();
    await f.callback(await f.begin(token));
    f.advance(3600000);
    f.setRefreshError(new GoogleGrantError(false));
    assert.equal((await f.post('/drive/token', { accountId: 'reader' }, token)).status, 502);
    assert.equal((await f.post('/session', {}, token)).body.driveReady, true);
    f.setRefreshError(new GoogleGrantError(true));
    assert.equal((await f.post('/drive/token', { accountId: 'reader' }, token)).body.error, 'drive_reconnect');
    assert.equal((await f.post('/session', {}, token)).body.driveReady, false);
    f.advance(31 * 86400000);
    assert.equal((await f.post('/session', {}, token)).status, 401);
  } finally {
    await f.close();
  }
});

test('Google server verifier validates signature, audience, nonce and expiry', async () => {
  const keys = await generateKeyPair('RS256');
  const provider = googleProvider({ clientId: 'client' }, fetch, async () => keys.publicKey);
  const sign = (aud = 'client', nonce = 'nonce', exp = '1h') =>
    new SignJWT({ nonce, email: 'reader@example.test' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('reader')
      .setIssuedAt()
      .setExpirationTime(exp)
      .setIssuer('https://accounts.google.com')
      .setAudience(aud)
      .sign(keys.privateKey);
  assert.equal((await provider.verify(await sign(), 'nonce')).subject, 'reader');
  await assert.rejects(provider.verify(await sign('other'), 'nonce'));
  await assert.rejects(provider.verify(await sign('client', 'wrong'), 'nonce'));
  await assert.rejects(provider.verify(await sign('client', 'nonce', 1), 'nonce'));
  const other = await generateKeyPair('RS256');
  const invalid = await new SignJWT({ nonce: 'nonce' })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject('reader')
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer('https://accounts.google.com')
    .setAudience('client')
    .sign(other.privateKey);
  await assert.rejects(provider.verify(invalid, 'nonce'));
});
