import { ArchiveImportError } from '../../services/import/import-service';
import { RemoteApiError } from '../../services/remote/remote-api-contracts';

function remoteErrorDetail(message: string): string | undefined {
  const trimmed = message.trim();
  if (!trimmed || trimmed.startsWith('<')) return undefined;
  try {
    const body = JSON.parse(trimmed) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const record = body as Record<string, unknown>;
    for (const value of [record.message, record.error]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  } catch {
    return trimmed.length <= 240 ? trimmed : undefined;
  }
}

export function importFailureMessage(fileName: string, error: unknown): string {
  if (error instanceof ArchiveImportError) return error.message;

  if (error instanceof RemoteApiError) {
    const detail = remoteErrorDetail(error.message);
    if (error.status === 401) {
      return `"${fileName}" 서버 인증에 실패했습니다. Bearer token을 다시 확인하세요.`;
    }
    if (error.status === 403) {
      return detail === 'cors_origin_denied' || detail === 'cors_preflight_denied'
        ? `"${fileName}" 요청을 서버가 차단했습니다. 현재 웹 주소가 CORS_ALLOWED_ORIGINS에 포함됐는지 확인하세요.`
        : `"${fileName}" 서버 접근이 거부됐습니다. Bearer token과 CORS 설정을 확인하세요.`;
    }
    if (error.status === 404) {
      return `"${fileName}" 업로드 작업을 서버에서 찾지 못했습니다. 파일을 다시 선택해 이어서 시도하세요.`;
    }
    if (error.status === 409) {
      return `"${fileName}" 업로드 상태가 서버와 충돌했습니다. 파일을 다시 선택해 이어서 시도하세요.`;
    }
    if (error.status === 413) {
      return `"${fileName}"이 서버 또는 reverse proxy의 크기 제한을 넘었습니다. MAX_UPLOAD_BYTES와 client_max_body_size를 확인하세요.`;
    }
    if (error.status === 429) {
      return `"${fileName}" 서버가 현재 바쁩니다. 잠시 후 다시 시도하세요.`;
    }
    if (error.status === 502 || error.status === 503 || error.status === 504) {
      return `"${fileName}" 서버 가져오기 서비스를 사용할 수 없습니다. API와 worker 상태를 확인하세요.`;
    }
    if (error.status >= 500) {
      return `"${fileName}" 서버 가져오기에 실패했습니다${detail ? `: ${detail}` : '.'}`;
    }
    return `"${fileName}"을(를) 가져오지 못했습니다${detail ? `: ${detail}` : '.'}`;
  }

  if (error instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(error.message)) {
    return `"${fileName}" 서버에 연결하지 못했습니다. 주소, HTTPS reverse proxy와 CORS 설정을 확인하세요.`;
  }
  if (error instanceof Error && error.message.trim()) {
    return `"${fileName}"을(를) 가져오지 못했습니다: ${error.message.trim()}`;
  }
  return `"${fileName}"을(를) 가져오지 못했습니다.`;
}
