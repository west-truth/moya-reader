# 내장 서버 P0 실행 구성과 검증

> **보관 문서 — 현재 실행 계획이 아닙니다.** 아래 지시·상태·검증 결과는 당시 기록입니다.
> 현재 기준은 [데스크톱 구조와 작업 범위](../../platforms/desktop.md)입니다. 이전 W01~W12 계획을 이어서 구현하지 않습니다.

기준: [내장 self-host 계획](2026-09-23-desktop-embedded-selfhost-plan.md). Windows 앱 릴리즈 완료 기록이 아니다.

## 선택한 구성

- 기존 PostgreSQL SQL·migration·API·worker·BullMQ/Redis를 그대로 사용한다.
- 서버의 `OBJECT_STORAGE_DIR` 설정으로 디스크 객체 저장을 선택한다. 설정하지 않은 기존 self-host는 S3를 계속 사용한다.
- 기존 공통 Reader를 remote 모드로 빌드하고 같은 API 서버에서 제공한다. 브라우저는 기존 계정/세션으로 인증한다.
- 실행기가 전용 프로필에 DB·큐·파일·임시 작업·인증 정보를 두고 자동 시작/종료한다. PostgreSQL·Redis는 loopback만 사용한다. 실행 파일과 데이터는 분리한다.

선택 근거:

1. DB 이식과 작업 큐 재작성은 서버 여러 서비스에 영향을 준다. 첫 검증에서 이를 늘릴 이유가 없다.
2. 파일 저장의 직접 SDK 호출은 `object-storage.ts`와 `document-series-snapshot.ts`에 모여 있었다. 같은 서버 호출 경계를 유지하며 파일 쓰기·읽기/range·복사·삭제만 연결했다. 새 클라이언트 저장소는 만들지 않았다.
3. [PostgreSQL 공식 Windows 배포 안내](https://www.postgresql.org/download/windows/)는 앱에 포함할 수 있는 ZIP 바이너리를 제공한다. 후보는 EDB PostgreSQL 16.15다.
4. [Redis Windows 빌드](https://github.com/redis-windows/redis-windows/releases/tag/7.2.16)는 Redis 공식 배포가 아닌 커뮤니티 Cygwin 빌드다. 서비스 설치나 .NET wrapper 없이 `redis-server.exe`와 함께 온 DLL을 사용하고, Windows 실행 검증과 제3자 고지/소스 제공을 릴리즈 조건으로 남긴다.
5. [MinIO 공식 저장소](https://github.com/minio/minio)는 유지보수 중단과 source-only 배포를 명시한다. 데스크톱용으로 새 MinIO 서비스를 동봉하는 대신 위의 작은 서버 파일 경계를 연결했다. 기존 Docker의 MinIO 설정은 바꾸지 않았다.

## 구현 파일

- `apps/server/src/services/file-object-store.ts`: 객체 key를 불투명 식별자로 취급하고, metadata/본문을 같은 임시 파일에 기록한 뒤 rename으로 게시한다. 취소 시 기존 객체를 유지한다.
- `apps/server/src/services/object-storage.ts`, `document-series-snapshot.ts`: 기존 서버 호출과 파일 backend 연결.
- `apps/server/src/routes/web-assets.ts`: 공통 웹 산출물 제공. API 인증 유지, 경로 탈출/외부 symlink 차단.
- `scripts/desktop/embedded-server.mjs`: DB 초기화·포트/비밀 유지·readiness·API/worker IPC 종료·Redis/PostgreSQL 종료. 전용 프로필 중복 실행과 DB major 불일치를 거부한다.
- `scripts/desktop/build-embedded-runtime.mjs`: Windows Node/PostgreSQL/Redis를 고정 URL·SHA-256으로 확인하고 기존 서버 production dependency 배포를 재사용한다.
- `scripts/desktop/smoke-embedded-server.mjs`: Docker 없는 실제 API·worker·DB·큐·파일·브라우저 읽기와 재시작 검증.
- `.github/workflows/desktop-embedded.yml`: Windows에서 같은 산출물/검사를 실행한다. 전체 프로필·인증 파일·실행 payload는 업로드하지 않는다.

실제 worker 시작에서 기존 TTS cache SQL이 PostgreSQL 예약어 `current_catalog`를 alias로 사용해 실패하는 것도 발견했다. 유지보수/조회 두 SQL의 alias를 `active_catalog`로 수정했다.

## 확인된 결과

Linux에서 시스템 설치 없이 임시 폴더에 해제한 PostgreSQL 16.15·Redis 7.0.15를 사용했다. 운영 Docker/DB에는 연결하지 않았다.

- 한글·공백이 있는 빈 프로필 → DB/큐/API/worker 시작.
- 같은 프로필 동시 실행 거부.
- 인증 없는 API 거부, 기존 계정 등록/로그인 사용.
- TXT 업로드·worker의 서재 반영·원본 읽기·읽던 위치 저장.
- 정상 종료·같은 프로필 재시작 후 같은 origin/책/읽던 위치/원본 보존.
- 실제 Chromium의 공통 웹 Reader에서 본문 표시.
- 별도 브라우저 세션에서 로그인 후 같은 서재 조회.
- 최종 코드의 Linux 측정: 첫 시작 3,188ms, 재시작 1,261ms. 관리 중인 네 프로세스(PostgreSQL 부모·Redis·API·worker)의 RSS 합계는 304,246,784바이트다. PostgreSQL 자식·실행기·WebView까지 포함한 전체 앱 메모리가 아니며, Linux 개발 의존성을 사용한 값이다.
- 종료 후 lock 제거, 새 프로필의 PostgreSQL/worker 로그에 SQL 오류 없음까지 확인했다. 타입 검사·관련 테스트 6개 파일 46개·변경 파일 lint를 통과했다.

Windows 1차 [CI 실행](https://github.com/west-truth/moya-reader/actions/runs/35871577692)에서 payload 생성은 통과했으나, PostgreSQL initdb가 한글이 포함된 절대 경로를 `??`로 읽어 실패했다. [상대 경로 재검증](https://github.com/west-truth/moya-reader/actions/runs/35872232896)에서는 초기 파일 생성 후 bootstrap 자식이 경로를 절대화할 때 실패했다.

이에 [Microsoft의 프로세스별 UTF-8 manifest 설정](https://learn.microsoft.com/en-us/windows/apps/design/globalizing/use-utf8-code-page)을 Windows 동봉 PostgreSQL EXE에 추가했다. 기존 trust manifest와 병합하며, 시스템 locale·사용자 데이터·short path 설정은 변경하지 않는다. 변경 recipe와 각 EXE의 변경 후 SHA-256을 payload에 기록한다. 이 설정은 Windows 10 1903 이상을 전제로 한다. 한글·공백 프로필 검사는 유지했다.

이후 Windows CI의 관리자 토큰으로 PostgreSQL을 직접 시작하면 거부되는 것을 확인했다. Windows에서는 `pg_ctl`의 restricted-token 시작 경로로 실행하고, 생성된 PostgreSQL PID를 감시하며 종료 시 `pg_ctl -m fast -w stop`을 사용하도록 수정했다.

**최종 [Windows CI](https://github.com/west-truth/moya-reader/actions/runs/35873228674)는 성공했다.** 제품 코드 기준은 `b7466ca`다. 한글·공백 프로필에서 DB/Redis/API/worker 실행, TXT 업로드·원본/읽던 위치 보존, 종료·재시작, 실제 Chromium Reader의 한글 본문 표시와 두 번째 세션 인증을 통과했다. 첫 시작 19,018ms, 재시작 2,625ms다. 네 관리 프로세스의 Working Set 합계는 288,768,000바이트이며 PostgreSQL 자식·실행기·WebView를 포함한 전체 앱 메모리는 아니다. 실제 별도 기기 접속과 개발 런타임이 전혀 없는 PC 검사는 P1에 남아 있다.

Windows payload의 크기 기록은 다음과 같다. 구성요소 값은 원본 해제/빌드 시점이며 PostgreSQL manifest 후처리 전 값이다. 합계는 최종 성공 후보를 실제 재귀 측정한 값으로 약 438.23MiB다. 압축 배포 크기나 완성된 데스크톱 앱 크기가 아니다.

| 구성                                |      바이트 |
| ----------------------------------- | ----------: |
| Node                                |  87,145,537 |
| PostgreSQL bin/lib/share            | 128,140,358 |
| Redis·동봉 DLL                      |  26,574,498 |
| 기존 서버와 production dependencies | 206,311,534 |
| 공통 웹 UI                          |  11,313,840 |
| 실행기·고지 등을 포함한 최종 합계   | 459,516,701 |

EDB 원본 ZIP에는 pgAdmin 등이 포함되어 332,441,502바이트지만, 후보에는 서버 bin/lib/share와 관련 라이선스만 넣는다. PostgreSQL PE의 `VCRUNTIME140.dll` 의존성도 확인했다. CI runner에 있는 Visual C++ 런타임을 일반 PC에도 있다고 가정하면 안 되므로, 앱 배포 단계에서 재배포 런타임을 포함하거나 자동 준비해야 한다. Tauri/WebView·소스 브라우저 등 후속 필수 구성과 함께 최종 설치 크기를 다시 측정한다.

## 다음 완료 조건

- [x] Windows payload의 같은 사용 흐름과 구성요소별 크기·관리 프로세스 메모리 기록. 전체 앱 메모리는 후속 측정.
- [x] Tauri 앱의 자동 실행·연결·상태 표시, 사용자에게 setup token 수동 입력을 요구하지 않는 로컬 bootstrap. Windows 후보 앱에서 검증.
- [x] Windows 후보 폴더 이동 후 Node 의존성 해결 확인. hoisted deploy한 runtime을 다른 한글 폴더로 옮기고 원래 위치가 없는 상태에서 앱과 서버 검증 통과. 최종 설치 프로그램 검증은 별도다.
- [ ] 다른 실제 기기 접속: 공유 설정·인증·HTTP/HTTPS와 세션 정책 검증.
- [x] launcher 강제 종료 후 소유권 확인·lock/DB 복구, 트레이/종료 UX. Linux와 Windows의 빈 서재/계정 보존 검사 통과.
- [ ] 실제 작업 진행 중 전원 종료·업데이트 복구의 추가 검증.
- [x] 원형 숫자 퍼센트 UI를 선별 연결하고 확인된 업로드 바이트/이미지 저장 수로 표시. 총량 미확정 경로는 단계 표시.
- [ ] 전체 기능/백업/이전/동기화의 후속 계획 수행.

Windows proof payload는 실행 구성을 검증하는 산출물이다. 라이선스 고지·대응 소스·모든 필수 기능/런타임을 확인하기 전 사용자 배포물로 공개하지 않는다.

## P1 진행: 앱 연결과 공통 접속 화면 (2026-09-24)

- Tauri가 동봉 Node 실행기를 private stdin/stdout pipe로 실행하고 실제 endpoint/인증을 메모리로 전달한다. 서버 readiness 전에는 서재를 만들지 않으며 실패 시 오류·재시도를 표시한다.
- 공통 Remote reader와 서버 가져오기 경로를 사용한다. 앱 소유자는 native 연결로 사용하고, 다른 브라우저는 기존 계정으로 로그인한다.
- 창 닫기에서 트레이 유지/서버와 앱 종료/돌아가기를 제공한다. 부모 pipe EOF도 정상 서버 종료를 요청하며, 초기화 도중 종료 요청은 초기화 정리 뒤 처리한다.
- 외부 접속은 선택한 사설 IPv4 인터페이스에 별도 HTTP listener를 열고 로그인 세션만 전달한다. DB/Redis/API 관리 포트는 loopback을 유지한다. 공유 해제는 listener와 기존 연결을 닫으며 로컬 서재는 계속 사용한다. 자동 재공유하지 않는다.
- 사용자 추가 요청에 따라 QR·주소 복사를 공통 `ServerAccessLink`로 만들어 데스크톱과 self-host 웹 설정에서 재사용한다. QR에는 주소만 들어가고 native 소유자 토큰은 들어가지 않는다. 이후 Cloudflare 기본 접속 방식을 아래와 같이 추가했다.
- 배포는 lockfile을 사용하는 hoisted production deploy로 바꾸어 절대 경로 junction에 의존하지 않도록 했다. native Windows 후보는 실제로 다른 한글 폴더로 이동해 검사한다.
- Linux: Rust check/프런트 타입 검사·관련 25 tests 통과. 실제 서버를 사용한 native pipe readiness, 중복 실행 차단, 부모 종료 EOF 정리, 초기화 도중 취소 검증 통과.
- Windows native 창/공유/종료/재시작은 아래 후속 CI에서 통과했다. P1 전체 완료나 최종 배포물로 취급하지 않는다. VC runtime/WebView2의 자동 준비, 재배포 고지·source, 전원 종료 후 복구, 실제 별도 기기 검증은 남아 있다.

### 사설망 브라우저 경로에서 발견한 공통 UI 수정

실제 사설 IPv4 주소의 HTTP 페이지에서 `crypto.randomUUID`가 제공되지 않아 공통 UI가 시작되지 않는 것을 재현했다. 보안 난수 `crypto.getRandomValues`를 사용하는 UUID v4 helper로 직접 호출부를 교체했다. 전용 UI나 별도 서재를 만들지 않았다. 수정 후 공통 웹 빌드에서 **사설망 로그인 → 같은 TXT 읽기 → 읽던 위치 변경 → 공유 해제 → 로컬 readiness 유지**를 Linux Chromium으로 통과했다. 서로 다른 물리 기기 검증은 아니다. 관련 UUID/내비게이션/연결 검사 22 tests와 타입·lint 검사도 통과했다.

### Cloudflare 기본 접속 방식 (2026-09-24)

- 외부 접속을 켤 때 Quick Tunnel을 기본 선택하고, LAN/Tailscale 직접 접속과 고정 Cloudflare 터널을 선택할 수 있게 했다. 원격 접속 자체는 자동으로 켜지지 않는다.
- `cloudflared` 2026.9.1을 SHA-256 확인 후 앱 실행 구성에 동봉한다. Windows 실행 파일은 54,976,432바이트(약 52.4MiB)를 추가한다. Apache-2.0 LICENSE를 동봉하며 Cloudflare 서비스 이용 조건은 별도다.
- 앱 소유자 API 앞에 외부 로그인용 gateway를 두고, loopback에서만 터널 연결을 받는다. 공개 Host/Origin을 확인하고 소유자 bearer와 계정 초기화/복구 경로는 전달하지 않는다. HTTPS 로그인 쿠키에는 Secure를 설정한다.
- 임시 주소 생성·취소·해제와 앱 종료 시 터널 정리를 연결했다. 고정 터널의 목적지 포트는 프로필에 보존하고, 토큰은 private native pipe와 자식 환경으로만 전달한다. 사용자 Cloudflare 설정 파일을 수정하지 않는다.
- `smoke-embedded-tunnel.mjs`로 새 빈 검증 서재를 생성하여 실제 Quick Tunnel의 HTTPS 웹 응답, 계정 로그인, 세션 쿠키, 소유자 토큰 차단, 해제 뒤 접근 중단과 로컬 사용 유지를 Linux에서 통과했다. 실제 Cloudflare 계정/도메인이 필요한 고정 터널의 종단 검증은 미실시다.
- Windows run `35884785547`에서 이동된 서버 payload와 웹 검사는 통과했다. native WebView 자동화 연결도 확인했으나 Node entrypoint의 Windows 경로 처리에서 `EISDIR lstat D:`가 발생했다. native 경로를 일반 Windows 경로로 정리하고 작업 디렉터리 기준 entrypoint로 시작하도록 수정했다.

### Windows 앱 검증 통과 (`aa36f2c`)

[Windows 실행 35885884320](https://github.com/west-truth/moya-reader/actions/runs/35885884320)에서 한글 폴더로 이동한 앱의 자동 서버 시작, native 공통 리더의 TXT 읽기, 계정 생성, QR·주소 표시, LAN 로그인/해제, 종료·재시작, 트레이 유지 중 서버 사용을 통과했다. 접속 방식의 초기값이 Cloudflare인 것도 UI에서 확인했다. Windows 자동 검사는 실제 연결 방식으로 LAN을 선택했고, Quick Tunnel의 실제 HTTPS 종단 검증은 Linux에서 수행했다. Windows의 실제 Cloudflare 연결과 고정 도메인 연결을 검증한 것으로 해석하지 않는다.

같은 실행의 독립 서버·웹 검사도 TXT 가져오기/보존/재시작, 별도 브라우저 로그인, HTTP 리더와 읽던 위치 변경/공유 해제를 통과했다. 서버 첫 시작 26,473ms, 재시작 2,217ms이며, 네 관리 프로세스 Working Set은 244,928,512바이트다. 최종 앱 전체 메모리가 아니다. cloudflared를 포함한 서버 payload는 514,464,353바이트(약 490.6MiB)이며 native EXE·WebView2·VC runtime을 모두 포함한 설치 크기는 아니다.

로컬 추가 검사: 공유 UI/gate 5 tests, HTTPS gateway/주소 검증 2 tests, TypeScript·Rust check·변경 파일 lint, native pipe/중복 시작/부모 EOF 정리/시작 취소를 통과했다. 개인 계정이나 운영 서재를 외부에 공개하지 않고 새 검증 프로필만 사용했다.

### 복구·대용량·백업 후속 검증 (`190ae35` 이후)

[Windows 실행 35910684486](https://github.com/west-truth/moya-reader/actions/runs/35910684486)에서 실제 launcher 강제 종료 후 같은 계정/주소로 복구, 중복 실행 차단, 정상 종료를 통과했다. native 앱의 읽기·공유·재시작·트레이 검사도 통과했다. 서버 ZIP을 새 프로필에 복원한 뒤 작품 ID·독서 위치·원본과 재시작 보존을 확인했다. 이 실행 전체는 **설치본 빌드의 PowerShell 서명 검사 모듈 로딩 오류로 실패**했으므로 전체 성공으로 표시하지 않는다. Windows PowerShell에 전달되는 모듈 경로를 해당 호스트의 기본 모듈로 제한하도록 보완했다.

같은 Windows 서버 검사: 첫 시작 7,279ms, 재시작 2,006ms, 관리 프로세스 Working Set 278,233,088바이트. guard를 포함한 런타임 파일 합계는 514,952,061바이트이며 앱 EXE/설치 필수 구성은 제외한다. 이전 표와 파일 포함 범위가 같지 않으므로 차이를 성능 개선으로 해석하지 않는다.

Linux에서는 529MiB 만화의 공통 UI 가져오기·이미지 읽기·원본 SHA-256 일치를 통과했다. 작은 EPUB/PDF도 원본 보존과 실제 리더 표시를 통과했다. PDF 검사에서 발견한 `.mjs` MIME 오류를 공통 정적 자산 응답에서 수정했다. 이미지 완료 수의 변화도 가져오기 작업의 활동으로 취급하여, 메시지가 같아도 진행 중인 작업이 시간 초과로 오인되지 않게 했다. 측정 범위와 미완료 기능은 [P2 지원표](2026-09-24-desktop-feature-support.md)를 따른다.

### Windows 설치본 검증 통과 (`3e747f1`)

[Windows 최종 실행 35911331300](https://github.com/west-truth/moya-reader/actions/runs/35911331300)은 전체 성공했다. 강제 종료 복구·native 앱·공유/해제·백업 복원·EPUB/PDF 표시·NSIS release 설치본 생성 및 설치 후 실행이 포함된다.

- 설치 파일: **129,088,926바이트 (약 129MB / 123MiB)**. VC 재배포 설치 파일과 WebView bootstrapper를 포함한다.
- release guard를 포함한 서버 runtime: **514,819,138바이트 (약 491MiB)**. 앱 EXE와 시스템 WebView 설치 크기는 별도다.
- 설치본: 개발용 Node·DB 경로를 PATH에서 제외한 상태에서 서버 readiness와 인증된 서재 조회 통과. native 앱을 종료한 뒤 `server.lock` 제거까지 확인했다.
- 같은 실행의 서버 검사: 첫 시작 9,228ms, 재시작 2,423ms, 관리 프로세스 Working Set 275,009,536바이트. 전체 앱 메모리나 설치본 시작 시간으로 표시하지 않는다.
- CI 결과의 `cleanMachine`은 **false**다. VC/WebView가 없는 새 PC에서의 최초 준비, 재배포 고지/대응 소스, 실제 타 기기 접속 검사는 여전히 남아 있다. 설치 후보를 일반 사용자 배포물로 공개하지 않았다.

이후 파일명이 없는 과거 업로드 세션의 타입/기본 용량 제한 방어를 보완했다. 해당 변경은 서버 타입 검사와 업로드/웹 자산 31개 검사로 확인했으며, 위 Windows 실행의 코드 기준과 구분한다.
