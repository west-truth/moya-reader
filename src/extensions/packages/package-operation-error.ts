const messages: Readonly<Record<string, string>> = {
  source_preferences_conflict: '확장 설정이 변경됐습니다. 설정을 다시 열어 주세요.',
  invalid_source_preferences: '확장 설정 값을 확인해 주세요.',
  source_browser_unavailable:
    '사이트 화면을 실행할 브라우저를 사용할 수 없습니다. 호스트의 브라우저 설치 상태를 확인해 주세요.',
  source_browser_failed: '소스의 사이트 화면 처리를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  source_connection_failed: '소스 사이트와의 연결이 끊겼습니다. 잠시 후 다시 시도해 주세요.',
  source_request_timeout: '소스 사이트의 응답 시간이 초과됐습니다. 잠시 후 다시 시도해 주세요.',
  source_body_limit: '소스가 반환한 데이터가 처리 가능한 크기를 넘었습니다. 앱이 최신 버전인지 확인해 주세요.',
  source_http_failed: '소스 사이트가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  execution_busy: '다른 확장 요청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.',
  execution_timeout: '확장 처리 시간이 초과됐습니다. 잠시 후 다시 시도해 주세요.',
  source_work_unavailable: '소스에서 작품 정보를 찾지 못했습니다. 작품 목록을 새로고침해 주세요.',
  source_release_unavailable: '소스의 회차 목록이 변경됐습니다. 회차 목록을 새로고침해 주세요.',
  invalid_source_assets: '소스가 올바른 이미지 파일을 반환하지 않았습니다.',
  apk_review_limit: '열린 설치 검토가 많습니다. 기존 검토를 취소한 뒤 다시 시도해 주세요.',
  package_repository_mangayomi: 'Mangayomi 저장소입니다. Mangayomi 확장 관리에서 추가해 주세요.',
  compatibility_feature_unsupported: '이 확장이 요구하는 기능을 아직 지원하지 않습니다.',
  source_address_denied: '로컬 서버 주소는 확장 설정에서 접근 허용이 필요합니다.',
  package_repository_suwayomi: 'APK 저장소입니다. APK 확장 관리에서 추가해 주세요.',
  apk_android_feature_unsupported: '이 소스에 필요한 Android 기능을 아직 지원하지 않습니다.',
  apk_worker_busy: '다른 APK 소스의 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.',
  apk_request_timeout: '소스 응답이 지연되어 작업을 중단했습니다. 다시 시도해 주세요.',
  apk_page_limit: '이 회차의 이미지 수가 현재 가져오기 한도를 넘습니다.',
  source_content_service_required:
    '이 소스에 승인된 본문 공급자 연결이 필요합니다. 서버의 확장 연결 설정을 확인해 주세요.',
  source_content_service_denied: '이 회차 주소는 본문 공급자 연결에 허용되지 않았습니다.',
  source_content_service_auth: '본문 공급자의 접속 인증을 확인해 주세요. 작품 검색용 계정과는 별도 연결입니다.',
  source_content_service_timeout: '본문을 준비하는 데 시간이 오래 걸립니다. 잠시 후 다시 시도해 주세요.',
  source_content_service_invalid: '본문 공급자가 올바른 텍스트를 반환하지 않았습니다.',
  source_content_service_failed: '본문 공급자 요청을 완료하지 못했습니다. 연결 상태를 확인해 주세요.',
  source_content_verification_required: '원래 사이트에서 본문 열람 확인이 필요합니다.',
  package_repository_conflict: '저장소가 변경됐습니다. 목록을 다시 확인한 뒤 시도해 주세요.',
  package_repository_limit: '저장소는 최대 16개까지 추가할 수 있습니다.',
  package_repository_origin_denied: '확장 파일은 저장소와 같은 HTTPS 주소에 있어야 합니다.',
  source_auth_required: '소스 계정 연결이 필요합니다. 확장 설정에서 저장된 연결을 확인해 주세요.',
  source_auth_forbidden: '이 계정으로 접근할 수 없습니다. 원래 사이트에서 이용 권한을 확인해 주세요.',
  source_auth_unavailable: '계정 연결을 사용할 수 없습니다. 확장 사용 여부와 앱 버전을 확인해 주세요.',
  package_update_publisher_mismatch:
    '업데이트 파일의 게시자가 달라 적용하지 않았습니다. 게시자 변경을 확인한 뒤 파일로 추가해 주세요.',
  package_repository_integrity: '업데이트 파일이 저장소의 안내와 다릅니다. 저장소 관리자에게 확인해 주세요.',
  invalid_package_repository: '업데이트 저장소 형식을 읽지 못했습니다. 저장소 관리자에게 확인해 주세요.',
  package_install_conflict: '다른 작업으로 확장이 변경됐습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.',
};
export function packageOperationMessage(error: unknown): string | undefined {
  return error instanceof Error && Object.prototype.hasOwnProperty.call(messages, error.message)
    ? messages[error.message]
    : undefined;
}
export function translatePackageOperationError(error: unknown): never {
  const message = packageOperationMessage(error);
  if (message) throw Object.assign(new Error(message), { cause: error });
  throw error;
}
