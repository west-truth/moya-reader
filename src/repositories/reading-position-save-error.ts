export type ReadingPositionSaveFailure =
  'connection' | 'timeout' | 'authentication' | 'permission' | 'missing' | 'rate-limit' | 'server' | 'response';

const messages: Record<ReadingPositionSaveFailure, string> = {
  connection: '서버에 연결하지 못해 읽기 위치를 저장하지 못했습니다.',
  timeout: '서버 응답이 늦어 읽기 위치를 저장하지 못했습니다.',
  authentication: '읽기 위치를 저장하지 못했습니다. 로그인 상태를 확인해 주세요.',
  permission: '서버에서 읽기 위치 저장 권한을 확인하지 못했습니다.',
  missing: '서버에서 작품 또는 회차를 찾지 못해 읽기 위치를 저장하지 못했습니다.',
  'rate-limit': '서버 요청이 제한되어 읽기 위치를 저장하지 못했습니다.',
  server: '서버 오류로 읽기 위치를 저장하지 못했습니다.',
  response: '서버가 읽기 위치 저장 요청을 처리하지 못했습니다.',
};

/** Only fixed messages/status codes cross into the reader; never raw server responses or URLs. */
export class ReadingPositionSaveError extends Error {
  constructor(
    readonly reason: ReadingPositionSaveFailure,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(messages[reason] + (status ? ` (HTTP ${status})` : ''));
    if (options) Object.defineProperty(this, 'cause', { value: options.cause, configurable: true });
    this.name = 'ReadingPositionSaveError';
  }
}
