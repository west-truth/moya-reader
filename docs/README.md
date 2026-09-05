# 모야 개발 문서

이 디렉터리는 공개 저장소에서 제품을 실행·빌드·유지보수하는 데 필요한 문서만 제공합니다. 개인 소설 corpus,
실험 결과, handoff packet, 내부 리뷰와 과거 작업 로그는 공개 저장소에 포함하지 않습니다.

## 설치와 운영

- [Ubuntu Docker Compose 설치·업데이트·백업](operations/docker-compose-guide-ko.md)
- [Docker Compose 구성 기술 문서](operations/docker-compose-deployment.md)
- [WireGuard + Nginx Proxy Manager + Suwayomi 배포](operations/nginx-proxy-manager-wireguard.md)
- [Hosted provider admission과 비용 경계](operations/hosted-provider-admission.md)
- [독서·가져오기 UX 동작과 검증](operations/reader-ux-verification.md)

## 데스크톱과 Android

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
- [외부 작품 소스와 Source Hub](architecture/external-library-sources.md)
- [AI/TTS provider 경계](architecture/provider-boundaries.md)
- [AI/TTS job·cache·보안](architecture/ai-tts-provider-job-cache-security.md)

구현 사실과 문서가 다르면 현재 소스와 테스트를 우선하고, 같은 변경에서 해당 공개 문서도 함께 고칩니다.
