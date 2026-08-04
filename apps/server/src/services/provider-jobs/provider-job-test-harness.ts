import type { ServerConfig } from '../../config.js';

export function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    redisUrl: 'redis://127.0.0.1:6379',
    dataDir: '.server-test-data',
    maxChunkBytes: 1024,
    maxUploadBytes: 1024 * 1024,
    staleUploadMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    s3: {
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
    },
  };
}

export function capturedSyncEvent(params?: unknown[]): Record<string, unknown> {
  return {
    id: params?.[0],
    user_id: params?.[1],
    type: params?.[2],
    book_id: params?.[3],
    entity_id: params?.[4],
    payload: JSON.parse(String(params?.[5])),
    revision: JSON.parse(String(params?.[6])),
    created_at: params?.[7],
  };
}
