/** Messages from this error are authored locally; remote diagnostics never reach the UI. */
export class TextServerRequestError extends Error {}

export function textServerErrorMessage(status: number, code?: unknown, managed = false): string {
  switch (code) {
    case 'text_source_server_not_configured':
      return '텍스트 소스 서버 연결이 설정되지 않았습니다. 서버 관리자에게 연결 설정을 요청해 주세요.';
    case 'authentication_required':
      return '텍스트 서버 연결 키가 올바르지 않습니다. 연결 키를 확인한 뒤 다시 연결해 주세요.';
    case 'origin_rejected':
    case 'preflight_rejected':
      return '텍스트 서버가 이 앱의 주소를 허용하지 않습니다. 서버의 허용 앱 주소 설정을 확인해 주세요.';
    case 'content_provider_not_configured':
    case 'invalid_content_provider_configuration':
    case 'unsupported_content_provider_protocol':
      return '텍스트 서버의 본문 제공자 설정이 필요합니다. 제공자 주소와 연결 키를 확인한 뒤 다시 시도해 주세요.';
    case 'content_provider_authentication_required':
      return '본문 제공자 인증에 실패했습니다. 텍스트 서버에 설정한 제공자 연결 키를 확인해 주세요.';
    case 'source_authentication_required':
    case 'source_access_required':
      return '원본 사이트 로그인이나 회차 이용 권한이 필요합니다. 본문 제공자의 로그인 상태와 해당 회차 권한을 확인해 주세요.';
    case 'source_verification_required':
    case 'source_security_verification_required':
      return '원본 사이트의 확인 절차가 필요합니다. 본문 제공자에서 확인 절차를 완료한 뒤 다시 시도해 주세요.';
    case 'content_provider_unavailable':
    case 'content_provider_request_failed':
      return '본문 제공자에 연결하지 못했습니다. 제공자 실행 상태와 텍스트 서버의 연결 설정을 확인해 주세요.';
    case 'content_provider_job_failed':
      return '회차 본문을 가져오지 못했습니다. 본문 제공자의 로그인 상태와 해당 회차 제공 여부를 확인해 주세요.';
    case 'content_provider_invalid_manifest':
      return '본문 제공자가 올바른 회차 원문을 반환하지 않았습니다. 제공자의 로그인 상태와 해당 회차 제공 여부를 확인해 주세요.';
    case 'content_provider_invalid_response':
    case 'content_provider_invalid_job':
    case 'content_provider_response_limit':
      return '본문 제공자 응답을 읽을 수 없습니다. 제공자의 호환성과 실행 상태를 확인해 주세요.';
    case 'content_provider_body_timeout':
    case 'content_provider_request_timeout':
      return '본문을 받는 시간이 초과되었습니다. 본문 제공자의 상태를 확인하고 잠시 뒤 다시 시도해 주세요.';
    case 'request_timeout':
    case 'source_timeout':
      return '텍스트 소스 응답 시간이 초과되었습니다. 서버 상태를 확인하고 잠시 뒤 다시 시도해 주세요.';
    case 'metadata_busy':
    case 'content_busy':
    case 'source_busy':
    case 'content_provider_busy':
      return '텍스트 소스가 다른 요청을 처리하고 있습니다. 잠시 기다린 뒤 다시 시도해 주세요.';
    case 'source_catalog_changed':
    case 'invalid_pagination':
      return '회차 목록이 변경되었거나 이어서 불러올 위치가 유효하지 않습니다. 목록을 새로고친 뒤 다시 선택해 주세요.';
    case 'source_catalog_limit':
      return '회차 목록 조회 한도에 도달했습니다. 목록을 새로고쳐 필요한 회차를 다시 선택해 주세요.';
    case 'source_pagination_stalled':
    case 'source_invalid_metadata':
    case 'source_invalid_response':
    case 'source_invalid_json':
    case 'invalid_adapter_response':
      return '텍스트 소스 응답 형식이 올바르지 않습니다. 서버의 소스 어댑터와 원본 사이트 상태를 확인해 주세요.';
    case 'content_unavailable':
      return '현재 가져올 수 없는 회차입니다. 회차 준비 상태와 이용 권한을 확인한 뒤 다시 시도해 주세요.';
    case 'source_request_failed':
      return '텍스트 소스 요청을 완료하지 못했습니다. 원본 사이트와 서버 상태를 확인하고 다시 시도해 주세요.';
    case 'source_browser_unavailable':
      return '텍스트 서버의 조회용 브라우저를 실행하지 못했습니다. 서버의 브라우저 설치와 실행 설정을 확인해 주세요.';
    case 'source_size_limit':
      return '회차 본문이 가져오기 크기 한도를 넘었습니다. 더 작은 TXT 회차를 선택해 주세요.';
    case 'invalid_utf8_content':
      return '회차 본문이 UTF-8 형식이 아닙니다. 본문 제공자의 TXT 출력 설정을 확인해 주세요.';
    case 'server_stopping':
      return '텍스트 서버가 종료되거나 다시 시작되는 중입니다. 잠시 뒤 다시 시도해 주세요.';
  }
  if (status === 401 || status === 403)
    return managed
      ? '모야 로그인 상태와 텍스트 소스 사용 권한을 확인한 뒤 다시 시도해 주세요.'
      : '텍스트 서버 연결 키와 접근 설정을 확인한 뒤 다시 연결해 주세요.';
  if (status === 404 || code === 'not_found')
    return '요청한 소스·작품·회차를 찾을 수 없습니다. 서버 주소를 확인하거나 목록을 새로고침해 주세요.';
  if (status === 429) return '텍스트 소스가 혼잡합니다. 잠시 기다린 뒤 다시 시도해 주세요.';
  if (status === 408 || status === 504) return '텍스트 소스 응답 시간이 초과되었습니다. 잠시 뒤 다시 시도해 주세요.';
  return '텍스트 서버 요청을 완료하지 못했습니다. 서버 상태를 확인하고 다시 시도해 주세요.';
}
