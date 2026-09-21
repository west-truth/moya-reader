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

  it('explains the upload size limit without exposing deployment settings', () => {
    const message = importFailureMessage('scan.pdf', new RemoteApiError('{"error":"payload too large"}', 413));
    expect(message).toContain('업로드 용량 한도');
    expect(message).toContain('scan.pdf');
  });

  it('explains insufficient temporary space without technical details', () => {
    expect(importFailureMessage('book.epub', new RemoteApiError('{"code":"upload_storage_full"}', 507))).toBe(
      '서버의 임시 저장공간이 부족합니다. 공간을 확보한 뒤 다시 시도해 주세요.',
    );
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
