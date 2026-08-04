# ADR: Tauri v2 Android shell과 local-first 모바일 제품

Status: accepted

Date: 2026-08-01

## Context

NovelDesk는 React/Vite Reader, IndexedDB local repository, 선택형 self-host server, Tauri Windows shell과
Android Keystore provider plugin을 이미 갖고 있다. 과거 문서는 Android shell을 Tauri와 Capacitor 중에서
검토 중이라고 적었지만 실제 코드는 Tauri mobile entry, Rust Android target, Android init/build scripts와
Kotlin plugin 경계까지 Tauri 방향으로 진행됐다.

오픈소스 사용자가 모두 서버를 운영할 수 없으므로 Android가 server-only remote client가 되면 현재의
오프라인 독서와 local data 소유권을 잃는다. 반대로 별도 Kotlin/Compose UI를 만들면 web, Windows와 Android의
기능 업데이트가 세 코드베이스로 갈라진다.

## Decision

1. Android 앱은 Tauri v2 shell로 구현한다.
2. Library, Chapters, Reader, parser/domain, repository/provider contract와 sync client는 현재 React/core를
   공유한다.
3. Android 전용 코드는 file/SAF, lifecycle/back, secure credential, system TTS/audio, deep link/share intent와
   permission 같은 platform adapter로 제한한다.
4. Android 기본 모드는 local IndexedDB를 사용하는 offline-first다.
5. self-host server는 body attach/Hosted library, cross-device sync, AI/TTS job과 cache를 제공하는 선택형
   service hub다.
6. Cloud Vault는 원문을 전송하지 않으며 Android adapter가 준비되기 전까지 자동 지원으로 간주하지 않는다.
7. server의 호환 가능한 worker/algorithm 변경은 server 배포로 공유할 수 있지만 UI/core/platform 변경은
   web/Windows/Android client를 다시 빌드하고 배포한다.

현재 공개 소스의 준비 사항과 build 명령은 [네이티브 빌드 가이드](../platforms/native-build-guide-ko.md)를 따른다.

## Consequences

장점:

- 기존 Reader와 모바일 반응형 UI를 재사용한다.
- 공통 제품 기능은 한 번 구현하고 세 client build에 전달할 수 있다.
- 서버 없이도 import와 독서가 가능하다.
- 현재 Rust provider/security 경계를 Android에서 계속 사용할 수 있다.

비용:

- Android WebView의 파일 접근, IndexedDB 지속성, back/process lifecycle와 background audio를 별도로
  검증하고 필요한 Kotlin plugin을 만들어야 한다.
- Play signing/SDK/NDK/ABI와 generated Gradle project를 운영해야 한다.
- store에 남아 있는 구형 APK를 위해 server API를 additive하게 rollout해야 한다.

## Rejected alternatives

- **별도 Kotlin/Compose 앱:** UI와 product logic 중복 및 업데이트 비용 때문에 제외한다.
- **Capacitor로 별도 shell 추가:** 현재 Tauri Rust/Keystore/provider 경계를 다시 연결할 이점보다 전환 비용이
  크므로 제외한다.
- **server-only Android client:** self-host를 쓰지 않는 사용자와 offline reading 요구를 충족하지 못해
  제외한다.
- **모든 desktop 기능의 즉시 1:1 화면 parity:** 모바일 정보 밀도와 출시 범위를 과도하게 키우므로 domain
  behavior는 공유하되 presentation은 cover/progress 중심으로 단순화한다.
