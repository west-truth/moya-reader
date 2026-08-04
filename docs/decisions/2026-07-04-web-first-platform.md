# ADR: 웹 우선 플랫폼 전략

Status: accepted
Date: 2026-07-04

## Context

초기 구현은 Tauri desktop 앱으로 시작했다. 하지만 앞으로 PC/모바일 웹에서 같은 책과 읽은 위치를 연동하려면 서버 호스팅과 sync가 필요하다. exe와 apk도 유지하고 싶지만, 플랫폼마다 완전히 다른 코드베이스를 만들면 기능 업데이트 비용이 커진다.

## Decision

앞으로 기능 개발은 웹 앱을 기준으로 진행한다. 데스크톱 exe와 향후 모바일 앱은 같은 React reader core와 domain logic을 사용하는 플랫폼 shell로 취급한다.

공통 코드:

- React reader UI.
- parser/domain types.
- repository/provider interfaces.
- sync protocol.
- AI/TTS provider contracts.

플랫폼별 코드:

- file picker/import adapter.
- local storage adapter.
- native TTS adapter.
- server auth/session adapter.
- background sync/import adapter.

## Consequences

장점:

- 웹 배포와 exe 배포가 같은 기능 세트를 공유한다.
- apk를 만들 때도 reader core를 재사용할 수 있다.
- 서버 sync를 붙여도 local-only mode를 유지할 수 있다.

비용:

- 지금 `App.tsx`에 섞인 storage/import/TTS orchestration을 service layer로 분리해야 한다.
- 큰 파일 처리는 web/desktop/mobile 모두 고려해 stream/page/cache 구조로 바꿔야 한다.
- IndexedDB origin migration과 server sync conflict 처리가 필요하다.

## Follow-up

- `ReaderRepository` interface 도입.
- `ImportService` interface 도입.
- 대용량 import/reader virtualization 구현.
- Docker Compose 기반 web/api/worker/postgres/minio/redis 구성 추가.
