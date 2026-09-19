# 공개 확장 플랫폼 작업 계획

기준일: 2026-09-20. 작업 브랜치: `fix/extension-install-update-covers`.
이 문서는 컨텍스트가 바뀌어도 구현 범위와 완료 조건을 유지하기 위한 진행 기준이다.
운영 서비스와 사용자 계정에는 설치·쓰기 작업을 하지 않는다.

## 현재 기준선

- Mangayomi JavaScript 23개 원본 중 AsuraScans, WordRain69, MangaDex 3개를 원본 fixture로 실행했다.
- 실사이트 콘텐츠 바이트 취득은 MangaDex의 목록 → 상세 → 회차 → 첫 이미지까지 성공했다.
- 실제 App 연결은 MangaDex 원본과 고정 HTTP fixture로 설치 → 설정 → 검색 → 회차 가져오기 → 읽기 → 재열기를 확인했다.
- 자체 `.moyaext`는 SDK/CLI tarball, init/check/run/dev/pack/keygen/index, 서명·업데이트·복원을 제공한다.
- SDK/CLI는 아직 `private: true`이고 PR, GitHub CI, 공개 게시와 운영 배포는 하지 않았다.

## 단계와 커밋 경계

### 1. 기존 기반 정리

- 설치·업데이트 확인, 네트워크 fallback, APK의 제한된 호환 수정, Mangayomi P0/HTTP/설정,
  SDK·CLI·서명·저장소 index, 원본 App gate와 terminal dev 흐름을 현재 기준선으로 커밋한다.
- `.tmp`, 로컬 archive/스크린샷/vault와 임시 진단 파일은 제외한다.
- 기존에 거부한 APK orphan archive 삭제와 async discard 설계는 포함하지 않는다.

완료 조건: 변경 범위의 타입 검사, 집중 테스트, 독립 CLI 설치 검사와 기존/원본 App gate가 통과한다.

### 2. 원본 corpus와 실사이트 호환 확대

- 고정 upstream revision의 Mangayomi JS 23개를 기능별로 분류하고 지원/미지원/외부 실패를 문서화한다.
- MangaDex 실제 한 회차를 격리 App으로 읽는다. 일반 HTML 만화는 Webtoons → MangaPill,
  일반 HTML 소설은 WebNovelTranslations → KolNovel 순서로 최소 요청을 수행한다.
- CopyManga가 실제 사용하는 `cryptoHandler`만 upstream 의미와 제한을 확인한 뒤 구현한다.
- EPUB, XPath, unpack, 호출 간 영구 인스턴스는 현재 corpus의 증거와 비용을 기준으로 명시적으로 제외하거나 후속으로 남긴다.
- 결과는 성공, 호환 API 부족, 인증 필요, 외부 HTTP/TLS/DNS 실패, 원본 selector 노후화로 구분한다.

요청 한도: 소스당 목록 1회, 상세 1개, 회차 1개, 첫 본문 또는 첫 이미지 1개.
완료 조건: 전체 23개 정적 분류, 최소 만화 2개·소설 1개의 실사이트 판정, MangaDex 실제 App 읽기.

### 3. 개발 편의와 공개 준비

- 개발 모드에 민감값을 제거한 메서드·단계·확장 버전·호출 ID 로그와 원본 소스 위치를 제공한다.
- `moya-extension preview`는 `127.0.0.1` 임시 포트, offline fixture 기본값, 명시적 `--network`로만 실행한다.
- dev watch 성공 시 preview를 갱신하고 실패 시 마지막 정상 화면과 오류를 유지한다.
- quickstart, SDK v1 API/오류/제한, 인증·브라우저 예제, 원본 호환표를 현재 구현과 일치시킨다.
- 서명된 GitHub Release용 SDK/CLI tarball과 예제 저장소 산출물을 준비한다. 실제 공개 게시와 운영 배포는 별도 단계다.

완료 조건: checkout 밖에서 생성 → watch → preview → 서명 pack → index 생성, 집중 회귀 검사와 GitHub 필수 CI 통과.

## 명시적 제외

- Dart, 영상 추출, Android 객체와 완전한 Android WebView 재현.
- APK 전체 호환 또는 기존 APK 사용자의 강제 이관.
- 사용 증거가 없는 helper의 선제 구현.
- 모든 사이트·모든 작품·장시간 운영을 자동화로 보증하는 과도한 실사이트 검사.

## 진행 기록

- [x] 1단계 기존 기반 정리 및 커밋
- [ ] 2단계 corpus·실사이트 호환 확대 및 커밋
- [ ] 3단계 개발 preview·공개 문서 및 커밋
- [ ] 최종 PR과 GitHub 필수 CI

### 1단계 검증 기록

- 확장 설치·업데이트 집중 검사, Web·서버·스크립트 타입 검사와 변경 범위 lint 통과.
- 독립 SDK/CLI tarball 설치와 `init/check/run/dev/pack/keygen/index` 흐름 통과.
- 기본 `.moyaext` App gate와 원본 MangaDex Mangayomi App gate 통과.
- APK 변경은 v2-only 서명, 지원 API 1.3~1.6, 업데이트 시 활성화 상태 유지와
  생성형 공용 entry point처럼 실제 자료에서 확인한 호환 수정만 포함한다.
