# 모야 Web 인증 서버

브라우저 재시작 후 로그인 복원과 Google Drive 접근 토큰 자동 갱신만 담당하는 선택적 서비스다.
책 원문·표지·독서 기록의 저장, 파싱, 파일 전송은 기존 브라우저 ↔ 개인 Drive 경로를 사용한다.
기존 self-host 책장 서버나 LLM/TTS worker를 실행할 필요는 없다.

2026-09-13: 코드·합성 Google 테스트용 구현. 사용자 요청에 따라 실제 OAuth 보안 비밀 입력과 공개 배포는 보류했다.
`VITE_GOOGLE_AUTH_URL`을 설정하지 않은 Web은 기존 서버 없는 Google 연결을 유지한다.

## 로컬 설정

Node 22.21 이상과 레포의 의존성이 필요하다. 레포 루트에서 실행한다.

```powershell
node services/web-auth/setup-local.mjs YOUR_PUBLIC_CLIENT_ID.apps.googleusercontent.com
```

이미 `.env`가 있으면 생성 스크립트는 덮어쓰지 않는다. `services/web-auth/.env`에서 다음을 설정한다.

- `GOOGLE_CLIENT_ID`: Web과 같은 공개 OAuth 클라이언트 ID.
- `GOOGLE_CLIENT_SECRET`: 같은 웹 OAuth 클라이언트의 보안 비밀. 서버 설정에만 직접 입력한다.
- `AUTH_ENCRYPTION_KEY`: 생성 스크립트가 만든 32-byte base64 암호화 키. 서버 재시작 때 바꾸지 않는다.
- `AUTH_PUBLIC_URL=http://localhost:1432`, `AUTH_WEB_ORIGINS=http://localhost:1422`.
- `AUTH_DB_PATH`: 영속 SQLite 파일 위치. 기본은 `services/web-auth/.data/auth.sqlite`.

Google Cloud에서 Drive API와 `drive.file` 동의를 설정하고, **승인된 리디렉션 URI**에
`http://localhost:1432/oauth/callback`을 추가한다. 기존 **승인된 JavaScript 원본**도 유지한다.
기존 GIS 로그인은 그대로 쓰고, Drive 연결만 서버 callback을 사용하는 OAuth code + PKCE 방식으로 바뀐다.

```powershell
corepack pnpm web:auth
```

`http://localhost:1432/health`가 성공하면 `apps/web/.env.local`에
`VITE_GOOGLE_AUTH_URL=http://localhost:1432`를 추가하고 Web dev 서버를 재시작한다.
이후 한 번 로그인하고 Drive 연결에 동의한다. 기존 브라우저의 책장·Vault 암호는 그대로 사용한다.
일반 사용자가 client ID나 보안 비밀을 입력하는 흐름은 없다.

## 저장과 수명

| 위치 | 저장 정보 |
| --- | --- |
| 브라우저 localStorage | 이 서비스·클라이언트에 한정된 임의의 모야 세션 토큰 |
| 브라우저 메모리 | 짧게 유효한 Google access token |
| 서버 SQLite | 모야 세션 토큰의 SHA-256 해시, 계정 subject/라벨, 만료 시각, AES-256-GCM으로 암호화한 Google refresh token |
| 서버 메모리 | 짧게 유효한 access token 캐시와 동시 갱신 병합 상태 |

모야 세션은 마지막 `/session` 복원 이후 30일, 최초 발급 후 최대 180일까지 유효하다.
새로 방문할 때 서버가 유효성을 확인하고, Drive 토큰은 실제 동기화가 필요할 때 갱신한다.
Google의 `invalid_grant`는 재연결 안내로 전환하고, 일시적인 네트워크/서버 오류로 refresh token을 버리지 않는다.
브라우저의 Google 토큰을 localStorage/IndexedDB·책장 백업에 저장하지 않는다.
모야 세션 토큰도 책장 백업·Drive 동기화 대상이 아니며, 로그아웃하면 로컬 토큰과 해당 서버 세션/갱신 정보를 삭제한다.
다른 기기의 독립 세션과 로컬 책장은 유지한다. Drive 연결 해제는 해당 세션의 갱신 정보만 삭제한다.
Google 계정 전체에서 앱 권한을 철회하는 기능과는 다르다.
오프라인 로그아웃은 로컬 세션을 먼저 지우며, 서버에 요청이 도달하지 못하면 원격 세션은 만료될 때까지 남을 수 있다.

Pages와 외부 인증 서버의 조합에서도 타사 쿠키 차단에 의존하지 않도록 명시적 Bearer 세션을 사용한다.
이 세션은 JavaScript에서 접근할 수 있으므로 같은 origin의 악성 스크립트에는 노출될 수 있다.
스크립트 실행 경계를 유지하고, 가능한 경우 전용 Web origin을 사용한다. 브라우저 저장소를 지우거나 저장을
차단하면 로그인 유지도 사라진다. 서버가 오프라인이면 독서는 계속되고 연결 복원/동기화는 재시도한다.

**Google External 앱의 Testing 상태에서는 Drive 같은 추가 범위의 refresh token이 7일 후 만료된다.**
실서비스에서 잦은 재연결을 없애려면 Google의 게시 상태·검증 조건도 충족해야 한다. 모야 세션 수명과 별개다.
[Google 토큰 만료 규칙](https://developers.google.com/identity/protocols/oauth2#expiration).

## 보안·운영 경계

- 로그인: 서버가 발급한 5분 일회용 nonce, Google 서명/issuer/audience/nonce/expiry 검증.
- Drive: 5분 일회용 state, PKCE, nonce, 로그인한 subject 대조. callback 재사용과 다른 계정 연결을 거절한다.
- 로그아웃/연결 해제 중 도착한 callback·refresh는 이전 연결을 복구하지 않는다.
- `/drive/token`도 서버 세션과 요청 계정을 대조한다. Google 401 후에는 캐시를 건너뛰고 갱신할 수 있다.
- 정확한 origin allowlist, JSON/custom header, Bearer 인증, 32KiB 요청 상한, Google HTTP timeout, `no-store`.
- 애플리케이션은 토큰·auth code·callback URL·요청 헤더/본문을 로그에 남기지 않는다. HTTPS 프록시도
  `/oauth/callback` 쿼리와 Authorization 헤더를 기록하지 않도록 설정한다.
- 현재는 단일 Node 프로세스와 영속 SQLite 기준이다. 순간 동시 갱신 병합과 IP별 분당 120회 제한은 메모리 기반이다.
  프록시 전달 IP를 자동 신뢰하지 않는다. 다중 인스턴스나 큰 공개 트래픽은 공유 rate limit/transaction store 등 후속 운영 설계가 필요하다.
- DB와 암호화 키를 함께 보호·백업한다. 키를 잃으면 Google 재연결이 필요하다. 책 원문 복원에는 영향을 주지 않는다.
- 프록시 TLS 종료, 인증 DB 볼륨 보존, 서버 패치와 별도 서비스 모니터링이 필요하다. 무료·무자원 운영을 보장하지 않는다.

## 배포 준비

레포 루트에서 `docker build -f services/web-auth/Dockerfile -t moya-web-auth .`로 단독 이미지를 만들 수 있다.
이미지는 Node 22 + jose만 실행한다. `/data`에 영속 볼륨을 연결하고 서버 환경 변수는 배포 환경의 비밀 저장소에서 제공한다.
Docker 이미지를 실제로 빌드/배포한 검증은 아직 없다.

운영 `AUTH_PUBLIC_URL=https://auth.example.com`과 실제 Web origin을 설정하고,
Google redirect URI를 `https://auth.example.com/oauth/callback`으로 등록한다.
Pages를 사용할 경우 Web origin은 `https://west-truth.github.io`이며, 공개 레포 Actions variable
`VITE_GOOGLE_AUTH_URL`에 인증 서버 주소를 넣는다. 소스 검증/공개 동기화 후 Pages를 명시적으로 배포한다.
`GOOGLE_CLIENT_SECRET`와 암호화 키는 Pages 변수·Vite 변수로 전달하지 않는다.

## 검증

```powershell
corepack pnpm check:web-auth
corepack pnpm exec vitest run apps/web/src/google src/config/public-runtime-config.test.ts src/features/cloud-vault/useCloudVaultController.test.ts
corepack pnpm web:build
corepack pnpm check:web-auth:browser
```

서버 검증은 임시 SQLite·합성 Google 응답으로 재시작/갱신, 계정 대조, CSRF/state 재사용, 취소 경합,
네트워크 장애/권한 철회, 만료, 실제 RSA 서명 검사를 실행한다.
브라우저 검증은 실제 Edge의 영속 프로필을 종료·재시작하고, 실제 인증 서버도 SQLite를 보존해 재시작한다.
Google SDK/인증 응답/Drive 파일 API만 합성이다. 새로고침, 브라우저/서버 재시작 뒤 재로그인·재동의 없이
원본 동기화와 갱신, 로그아웃 뒤 재방문을 확인한다. 실제 Google 계정의 code/refresh·Safari/PWA·공개 HTTPS 검증은 별도다.
