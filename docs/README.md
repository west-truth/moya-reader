# 모야 개발 문서

이 디렉터리는 제품 실행·빌드·유지보수 문서를 제공합니다. 현재 안내는 아래 색인을 따릅니다.
`archive/`는 중단되거나 대체된 설계의 보관 장소이며, 현재 구현 지시로 사용하지 않습니다. 개인 소설과 비밀 정보는 포함하지 않습니다.

## 설치와 운영

- [Ubuntu Docker Compose 설치·업데이트·백업](operations/docker-compose-guide-ko.md)
- [Docker Compose 구성 기술 문서](operations/docker-compose-deployment.md)
- [WireGuard + Nginx Proxy Manager + Suwayomi 배포](operations/nginx-proxy-manager-wireguard.md)
- [Hosted provider admission과 비용 경계](operations/hosted-provider-admission.md)
- [독서·가져오기 UX 동작과 검증](operations/reader-ux-verification.md)
- [텍스트 소스 서버 설치·연결·회차 사용](operations/external-text-sources.md)

## 데스크톱과 Android

- [현재 데스크톱 구조·작업 범위](platforms/desktop.md) — 데스크톱 작업은 이 문서에서 시작합니다.
- [보관된 데스크톱 계획·검토 기록](archive/desktop-2026-09/README.md) — 과거 기록이며 실행 지시가 아닙니다.
- [Windows·Android 네이티브 빌드 가이드](platforms/native-build-guide-ko.md)
- [Tauri v2 Android shell 결정](decisions/2026-08-01-tauri-v2-android-shell.md)
- [웹 우선 공통 제품 구조 결정](decisions/2026-07-04-web-first-platform.md)

## 아키텍처

- [현재 전체 구조](architecture/current-architecture.md)
- [데이터 모델과 저장소](architecture/data-model-and-storage.md)
- [가져오기와 parser](architecture/import-parser.md)
- [문서 형식과 고정 레이아웃 viewer](architecture/document-formats-and-fixed-layout-viewer.md)
- [책장 폴더 가져오기와 동기화](architecture/library-folder-import-and-sync.md)
- [대용량 파일과 동기화](architecture/large-file-and-sync-architecture.md)
- [Cloud Vault](architecture/cloud-vault-sync.md)
- [신뢰 익스텐션 v1 개발 가이드](architecture/trusted-extensions.md)
- [JS/TS 소스 확장 개발과 배포](extensions/source-development.md)
- [Source SDK v1 빠른 참조](extensions/sdk-v1-reference.md)
- [Mangayomi JavaScript 지원 범위와 검사](extensions/mangayomi-compatibility.md)
- [Mangayomi 원본 corpus와 실사이트 판정](extensions/mangayomi-corpus-2026-09-20.md)
- [Mangayomi JS 호환성과 확장 플랫폼 검토](extensions/platform-review-2026-09-19.md)
- [외부 작품 소스와 Source Hub](architecture/external-library-sources.md)
- [AI/TTS provider 경계](architecture/provider-boundaries.md)
- [AI/TTS job·cache·보안](architecture/ai-tts-provider-job-cache-security.md)

구현 사실과 문서가 다르면 현재 소스와 테스트를 우선하고, 같은 변경에서 해당 공개 문서도 함께 고칩니다.

- [공개 확장 릴리스 절차](extensions/publishing.md): 독립 CLI·게시자 서명·저장소 목록 생성과 검증
