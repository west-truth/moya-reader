import { describe, expect, it } from 'vitest';
import { ArchiveImportError } from '../../services/import/import-service';
import { RemoteApiError } from '../../services/remote/remote-api-contracts';
import { importFailureMessage } from './import-failure-message';

describe('importFailureMessage', () => {
  it('explains bearer authentication failures', () => {
    expect(importFailureMessage('book.epub', new RemoteApiError('{"error":"unauthorized"}', 401))).toContain(
      'Bearer token',
    );
  });

  it('distinguishes CORS rejection from generic access denial', () => {
    expect(importFailureMessage('book.epub', new RemoteApiError('{"error":"cors_origin_denied"}', 403))).toContain(
      'CORS_ALLOWED_ORIGINS',
    );
  });

  it('points size failures to both server and reverse proxy limits', () => {
    const message = importFailureMessage('scan.pdf', new RemoteApiError('{"error":"payload too large"}', 413));
    expect(message).toContain('MAX_UPLOAD_BYTES');
    expect(message).toContain('client_max_body_size');
  });

  it('identifies unavailable API or worker services', () => {
    expect(importFailureMessage('book.txt', new RemoteApiError('Service Unavailable', 503))).toContain('worker');
  });

  it('preserves actionable archive and ordinary error details', () => {
    expect(
      importFailureMessage('locked.cb7', new ArchiveImportError('압축 파일 암호가 필요합니다.', 'password_required')),
    ).toBe('압축 파일 암호가 필요합니다.');
    expect(importFailureMessage('broken.txt', new Error('decode failed'))).toContain('decode failed');
  });
});
