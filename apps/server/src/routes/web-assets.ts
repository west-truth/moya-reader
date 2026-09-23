import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/** Only the explicit asset route is public; all API routes keep their authentication. */
export function isWebAssetRequest(request: FastifyRequest): boolean {
  return (
    request.routeOptions.url === '/*' &&
    ['GET', 'HEAD'].includes(request.method) &&
    !/^\/(api(?:\/|$)|metrics(?:\/|$)|health(?:\/|$)|ready(?:\/|$))/.test(request.url.split('?')[0])
  );
}

export async function registerWebAssets(app: FastifyInstance, directory: string): Promise<void> {
  const root = await realpath(directory);
  await stat(path.join(root, 'index.html'));
  app.get<{ Params: { '*': string } }>('/*', async (request, reply) => {
    if (!isWebAssetRequest(request)) return reply.code(404).send({ error: 'not_found' });
    const name = request.params['*'] || 'index.html';
    if (name.includes('\\') || name.split('/').some((part) => part.startsWith('.'))) return reply.code(404).send();
    let target = await realpath(path.join(root, name)).catch(() => undefined);
    if (!target && !path.extname(name) && request.headers.accept?.includes('text/html')) {
      target = path.join(root, 'index.html');
    }
    if (!target || !target.startsWith(root + path.sep)) return reply.code(404).send();
    const info = await stat(target);
    if (!info.isFile()) return reply.code(404).send();
    reply.header('Content-Type', mime[path.extname(target)] ?? 'application/octet-stream');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-cache');
    reply.header('Content-Length', info.size);
    return reply.send(createReadStream(target));
  });
}
