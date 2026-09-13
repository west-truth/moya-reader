import Fastify from 'fastify';
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { readSeriesImageArchiveManifest } from '@noveldesk/fixed-document-core/series-image-archive';
import { describe, expect, it, vi } from 'vitest';
import { registerPreparedSourceImages } from './prepared-source-images.js';
import { registerAuthHook } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { ExternalSourceRegistryPort } from '../../../../src/external-sources/app-external-source-registry.js';

describe('hosted image preparation HTTP boundary', () => {
  it('keeps binary data behind authentication and produces a fenced delta for the regular import worker', async () => {
    const writer = new ZipWriter(new BlobWriter());
    await writer.add(
      '1.png',
      new Uint8ArrayReader(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
      ),
    );
    const file = new File([await writer.close()], '1.cbz', { type: 'application/vnd.comicbook+zip' });
    let generation = 'one';
    const registry = {
      getExternalSourceStatus: () => ({ state: 'connected', connectionGeneration: generation }),
      downloadExternalSource: vi.fn(async () => ({ file, content: { kind: 'image_archive', file, format: 'cbz' } })),
    } as unknown as ExternalSourceRegistryPort;
    const stage = vi.fn(async (archive: File) => {
      const manifest = await readSeriesImageArchiveManifest(archive);
      expect(manifest?.targetBookId).toBe('book');
      expect(manifest?.chapters[0]?.expectedPreviousSourceContentHash).toBe(`sha256:${'a'.repeat(64)}`);
      return { uploadId: 'upload', sourceContentHash: `sha256:${'b'.repeat(64)}`, byteLength: archive.size };
    });
    const app = Fastify();
    await registerAuthHook(app, { host: '127.0.0.1', authToken: 'test-token' } as ServerConfig);
    registerPreparedSourceImages(
      app,
      registry,
      async () => {},
      stage,
      async (reply, run) => {
        try {
          return await run();
        } catch (error) {
          return reply.code(422).send({ error: String(error) });
        }
      },
      (_request, _reply, run) => run(new AbortController().signal),
    );
    const url = '/api/extensions/sources/fixture/prepared-images';
    const headers = { authorization: 'Bearer test-token' };
    const payload = { key: { connectorId: 'fixture', remoteId: 'chapter' }, fileName: '1.cbz' };
    try {
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
      const receipt = await app.inject({ method: 'POST', url, headers, payload });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.headers['content-type']).toContain('application/json');
      expect(receipt.json()).not.toHaveProperty('file');
      const assembly = {
        artifactId: receipt.json().artifactId,
        remoteId: 'chapter',
        clientBookId: 'book',
        collection: { remoteId: 'work', title: 'Work' },
        release: { title: 'First', sourceOrder: 1 },
        importMode: 'append_image_series',
        baseActiveContentRevisionId: 'base',
        expectedPreviousSourceContentHash: `sha256:${'a'.repeat(64)}`,
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${url}/assemble`,
            headers,
            payload: { ...assembly, baseActiveContentRevisionId: undefined },
          })
        ).statusCode,
      ).toBe(400);
      const assembled = await app.inject({ method: 'POST', url: `${url}/assemble`, headers, payload: assembly });
      expect(assembled.statusCode, assembled.body).toBe(200);
      expect(assembled.json().uploadId).toBe('upload');
      expect(stage).toHaveBeenCalledOnce();
      expect(
        (await app.inject({ method: 'POST', url: `${url}/assemble`, headers, payload: assembly })).statusCode,
      ).toBe(422);
      const stale = (await app.inject({ method: 'POST', url, headers, payload })).json();
      generation = 'two';
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${url}/assemble`,
            headers,
            payload: { ...assembly, artifactId: stale.artifactId },
          })
        ).statusCode,
      ).toBe(422);
      expect(stage).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
