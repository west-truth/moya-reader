# 모야 개발 문서

이 디렉터리는 공개 저장소에서 제품을 실행·빌드·유지보수하는 데 필요한 문서만 제공합니다. 개인 소설 corpus,
실험 결과, handoff packet, 내부 리뷰와 과거 작업 로그는 공개 저장소에 포함하지 않습니다.

## 설치와 운영

- [Ubuntu Docker Compose 설치·업데이트·백업](operations/docker-compose-guide-ko.md)
- [Docker Compose 구성 기술 문서](operations/docker-compose-deployment.md)
- [WireGuard + Nginx Proxy Manager + Suwayomi 배포](operations/nginx-proxy-manager-wireguard.md)
- [Hosted provider admission과 비용 경계](operations/hosted-provider-admission.md)
- [독서·가져오기 UX 동작과 검증](operations/reader-ux-verification.md)
- [텍스트 소스 서버 설치·연결·회차 사용](operations/external-text-sources.md)

## 데스크톱과 Android

- [현재 데스크톱 구현 계획: 앱에 포함된 self-host와 다른 기기 접속](platforms/2026-09-23-desktop-embedded-selfhost-plan.md)
- [이전 IndexedDB 확장 작업의 브랜치 보관 기록](platforms/2026-09-23-desktop-indexeddb-archive.md)
- [데스크톱 포터블 단독 실행과 공개 릴리즈 계획](platforms/2026-09-23-desktop-release-plan.md)
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
