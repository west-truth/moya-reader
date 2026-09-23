import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerAuthHook } from '../auth.js';
import { loadConfig } from '../config.js';
import { registerWebAssets } from './web-assets.js';

it('serves the login UI without making API routes or files outside the web bundle public', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'moya-web-'));
  const outside = `${root}-secret`;
  const app = Fastify();
  try {
    await writeFile(path.join(root, 'index.html'), '<html>Reader</html>');
    await writeFile(outside, 'private');
    await writeFile(path.join(root, 'main.js'), 'export {}');
    await registerAuthHook(app, loadConfig({ SERVER_WEB_ROOT: root, READER_AUTH_TOKEN: 'test-token' }));
    await registerWebAssets(app, root);
    app.get('/api/books', async () => ({ books: [] }));
    expect((await app.inject('/')).body).toBe('<html>Reader</html>');
    expect((await app.inject('/main.js')).headers['content-type']).toContain('text/javascript');
    expect((await app.inject('/api/books')).statusCode).toBe(401);
    expect((await app.inject('/api/missing')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/books', headers: { authorization: 'Bearer test-token' } })).statusCode).toBe(
      200,
    );
    expect((await app.inject('/missing.js')).statusCode).toBe(404);
    expect((await app.inject('/%2e%2e/secret')).statusCode).not.toBe(200);
    if (process.platform !== 'win32') {
      await symlink(outside, path.join(root, 'outside.txt'));
      expect((await app.inject('/outside.txt')).statusCode).toBe(404);
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
