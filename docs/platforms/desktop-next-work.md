# 데스크톱 다음 작업: 정리본 검증과 기존 서버 직접 접속

상태: **A·B 기존 후보 검증 완료 · 추가 검토 수정본 Windows 미검증 · C 공개 배포 조건 미완료** · 2026-09-25.
제품 구조의 기준은 [desktop.md](desktop.md)입니다. 이 문서는 그 구조를 구현·검증할 다음 워커의 실행 순서를 정합니다.
진행 결과는 이 문서에 갱신하며, 별도 날짜별 계획을 계속 만들지 않습니다.

## 1. 목표와 범위

**기존 self-host를 Windows에서 앱처럼 사용한다. 서재의 원본은 선택한 서버 한 곳에 둔다.**

```text
이 PC의 서재 사용: 앱의 기존 화면 → 내장 self-host → 이 PC의 DB·파일
기존 서버 사용:   앱 창의 서버 화면 → 기존 self-host → 기존 서버의 DB·파일
다른 기기 사용:   브라우저 → 위에서 선택한 서버의 같은 서재
자료를 옮길 때:   기존 백업 → 대상 서버에서 복원
```

다음 작업의 순서는 **A. 정리본 Windows 검증 → B. 직접 접속 최소 구현 → C. 최종 후보 검증**입니다.
A에서 실패하면 그 원인부터 고칩니다. 새 기능을 더하며 실패를 덮지 않습니다.

| 작업                     | 필요한 이유                                                      | 비용을 제한하는 방법                                   |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------ |
| 정리본 Windows 실행 확인 | 서버 검사만으로 앱 시작·종료·패키징을 보장할 수 없음             | 기존 smoke와 런타임·빌드 스크립트 사용                 |
| 기존 서버 직접 접속      | 서버가 이미 있으면 같은 서재에 로그인해서 사용해야 함            | 기존 서버의 웹 UI·로그인·API 사용, 먼저 작은 실행 검증 |
| 선택한 서버 기억·전환    | 다음 실행에서도 같은 서재를 열고 잘못된 서버 접근을 피함         | 한 번에 하나, 전환은 우선 재시작 시 적용               |
| 최종 후보 검사           | 직접 접속 추가가 내장 서버와 일반 웹에 영향을 주지 않았는지 확인 | 기능별 검사 후 Windows 후보 하나로 묶어서 검사         |

이번 작업에 독립 서버 간 자동 복제, 두 서재 병합, 오프라인 독립 편집 후 병합, 새 충돌 해결 체계, 네이티브 대용량 IndexedDB 저장소를 추가하지 않습니다.
기존 `/api/sync`와 `/api/sync/events`는 일반 클라이언트가 쓰므로 유지합니다. 이름에 sync가 있다는 이유로 제거하지 않습니다.
Tailscale 자동 설치·설정, 새 provider 기능, 모든 구형 백업 변환은 선행 조건이 아닙니다.
물리적 다른 기기 검증은 제외하고, 같은 PC의 별도 브라우저·격리 서버와 Windows CI로 검증합니다.

## 2. 시작 위치와 보존할 것

- 저장소: `/home/koho5155/Docker_Services/.worktrees/moya-desktop-selfhost`
- 작업 브랜치: `refactor/desktop-single-server`
- 코드 정리 기준: `cb833c8`, 기존 구조 문서 정리: `62a76da`.
- 제거 전 전체 보관: `archive/desktop-peer-sync-20260924`의 `83236ac`.
- 옛 `feat/desktop-embedded-selfhost` 및 `/tmp/moya-desktop-portable`에서 재개하지 않습니다. 보관 문서의 W01~W12는 현재 할 일 목록이 아닙니다.
- 시작 시 `git status --short --branch`, `git log -5 --oneline`으로 이후 변경을 확인합니다. 다른 사람의 미커밋 변경을 되돌리지 않습니다.
- 운영 서버·사용자 profile에는 검사를 실행하지 않습니다. smoke의 임시 profile과 통합 검사의 별도 DB를 사용합니다.
- migration 0052~0055는 적용 이력 호환을 위해 유지했습니다. 복제 제거를 이유로 삭제하거나 사용자 DB를 다운그레이드하지 않습니다.

이미 남긴 공통 수정은 독서 위치와 이벤트의 함께 저장, 삭제 후 늦은 위치 저장 차단, 변경 번호/commit 순서 역전 처리, 주석 소유자·위치 검사, 가져오기 시 유효한 독서 상태 보존입니다.
복제 전용 코드와 구분해서 검증했고, 이유 없이 일괄 롤백하지 않습니다.

정리 당시 관련 90개 검사와 저장 경로 묶음 41개, 타입·린트·서버 production build를 확인했습니다. 이후 **정리본의 실제 Windows 검증도 통과했습니다**. 근거는 A 결과를 참조합니다.
과거 feature 브랜치의 Windows 성공을 정리본의 증거로 쓰지 않습니다. 작성 시 GitHub Releases 게시물이 없었으므로, 배포본 비교가 필요하면 먼저 실제 사용한 파일·Actions run·SHA를 식별합니다.

## 3. 현재 호출 경로와 수정 후보

아래는 존재하는 코드입니다. 새 파일명은 구현 시 정하되 별도 서버나 데이터 계층을 만들지 않습니다.

| 파일                                                                                                                                                     | 현재 역할 / 다음 작업에서 확인할 점                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [src/main.tsx](../../src/main.tsx)                                                                                                                       | embedded 빌드이면 `EmbeddedServerGate`를 거쳐 내장 서버의 URL·token으로 runtime 생성                             |
| [EmbeddedServerGate.tsx](../../src/platform/EmbeddedServerGate.tsx)                                                                                      | mount 시 서버 시작, 상태 조회, 공유 및 종료 화면. 기존 서버 모드에서는 mount하지 않아야 함                       |
| [reader-runtime.ts](../../src/repositories/reader-runtime.ts)                                                                                            | `mode: remote`는 내장/외부 모두 사용할 수 있는 API repository. `local`은 IndexedDB이며 '내장 서버'의 뜻이 아님   |
| [app-runtime.ts](../../src/app/runtime/app-runtime.ts)                                                                                                   | repository·provider·수집기 실행 위치 구성. 선택한 서버와 다른 실행 경로가 섞이지 않는지 확인                     |
| [SelfHostAccountGate.tsx](../../src/features/auth/SelfHostAccountGate.tsx), [self-host-auth-client.ts](../../src/features/auth/self-host-auth-client.ts) | 일반 서버의 계정 로그인. `managedByDesktop`이면 생략하므로 외부 서버에 이 flag를 사용하면 안 됨                  |
| [remote-api-client.ts](../../src/services/remote/remote-api-client.ts), [auth-cookie.ts](../../apps/server/src/auth-cookie.ts)                           | 현재 요청은 `same-origin`, 세션 cookie는 `HttpOnly; SameSite=Strict`. URL만 바꾸면 로그인이 된다고 가정하지 않음 |
| [embedded_server.rs](../../src-tauri/src/embedded_server.rs), [app.rs](../../src-tauri/src/app.rs)                                                       | 내장 서버 시작·종료·트레이. 현재 stop은 앱 종료와 연결되어 있음                                                  |
| [default.json](../../src-tauri/capabilities/default.json), [runtime.ts](../../src/platform/runtime.ts)                                                   | native 권한과 플랫폼 판별. 외부 페이지가 로컬 실행 권한을 얻거나 native 경로로 잘못 분기하면 안 됨               |
| [embedded-server.mjs](../../scripts/desktop/embedded-server.mjs)                                                                                         | 기존 self-host API·worker·DB·queue의 실행과 종료. 저장 기능 자체를 다시 구현하지 않음                            |
| [desktop-embedded.yml](../../.github/workflows/desktop-embedded.yml)                                                                                     | 현재 Windows 검증 workflow. 자동 push 대상은 옛 feature 브랜치뿐임                                               |

## 4. A — 정리본 Windows 검증을 먼저 완료

### A1. 준비와 실행

1. 현재 코드 SHA와 작업 트리가 깨끗한지 기록합니다. 이미 통과한 로컬 검사를 변경 없이 전부 반복하지 않습니다. 새 환경이라면 의존성과 필요한 통합 검사부터 확인합니다.
2. Windows가 없으면 기존 Actions workflow를 정리 브랜치에서 수동 실행합니다. **현재 push trigger는 `refactor/desktop-single-server`에서 실행되지 않습니다.** 옛 브랜치를 대신 빌드하지 않습니다.
3. 원격에 정리 브랜치가 없으면 후보 커밋을 해당 브랜치로 push한 후 실행합니다. 이 문서는 작업 방법이며, 이번 문서 작성에서 push나 CI를 실행한 것은 아닙니다. 실제 실행은 세션에서 허용된 범위를 따릅니다.
4. 첫 실행은 `build_installer=false`로 시작합니다. 실패 원인과 관계없는 전체 패키징 재실행을 반복하지 않습니다.

```bash
git rev-parse HEAD
gh workflow run desktop-embedded.yml --ref refactor/desktop-single-server -f build_installer=false
gh run list --workflow desktop-embedded.yml --branch refactor/desktop-single-server --limit 3
# 위 목록에서 해당 SHA의 run ID를 확인한 뒤:
gh run view <RUN_ID> --json headSha,status,conclusion,url,jobs
gh run download <RUN_ID> --name embedded-windows-evidence --dir .tmp/single-server-proof-<RUN_ID>
```

직접 Windows에서 실행할 때는 [빌드 가이드](native-build-guide-ko.md)의 전용 명령을 사용합니다.

```powershell
node scripts/desktop/build-embedded-runtime.mjs
node scripts/desktop/build-embedded-app.mjs
node scripts/desktop/smoke-embedded-recovery.mjs ".tmp/Moya app 한글/embedded-server/runtime.json"
node scripts/desktop/smoke-embedded-app.mjs ".tmp/Moya app 한글/Moya.exe"
node scripts/desktop/smoke-embedded-formats.mjs ".tmp/Moya app 한글/embedded-server/runtime.json"
```

### A2. 확인할 결과

- 새 임시 profile에서 앱이 내장 서버를 시작하고 TXT·EPUB·PDF 서재를 엽니다.
- 독서 위치·북마크·PDF 주석이 재시작 뒤 유지됩니다. 기존 smoke가 검사하는 실제 항목을 로그와 대조합니다.
- 기존 백업을 만들고 별도 임시 profile에 복원해 작품 수·주석·원본 바이트를 확인합니다. 현재 기본 smoke의 작품 수는 복제용 작품을 제외한 **3권**입니다.
- 공유 켜기/해제, 트레이 유지, 정상 종료, 강제 종료 후 같은 profile 복구가 동작합니다.
- 수집기가 없거나 실패해도 서재는 열립니다. 공개 사이트 live probe는 workflow에서 허용된 실패이므로 전체 green만 보고 실사이트 수집 성공으로 적지 않습니다.
- 연결/복제 화면과 `/api/sync/peer...` 실행 경로가 다시 생기지 않습니다. 백업 복원 검사용 두 번째 임시 서버는 자동 복제가 아닙니다.

**완료 기준:** 검사 코드의 SHA와 Actions `headSha`가 일치하고, 결과 JSON·로그에서 필수 단계 성공을 확인합니다. 실패는 재현 조건·수정·재검사로 닫습니다. 종료 timeout을 늘리는 것만으로 원인 해결이라고 기록하지 않습니다.
실행 환경이 없으면 A는 `환경 대기`이며 성공으로 표시하지 않습니다.

## 5. B — 기존 서버 직접 접속을 작게 구현

### B1. 먼저 로그인 방식의 작은 실행 검증

권장안은 **기존 서버가 제공하는 웹 페이지를 앱의 별도 WebView 창에서 열어, 그 서버의 일반 웹 로그인과 API를 그대로 사용하는 방식**입니다.
같은 origin에서 동작하므로 기존 cookie 인증을 재사용할 수 있는 방향입니다. 아래는 구현 당시의 검증 순서이며 실제 결과는 8절에 기록했습니다.

1. 같은 PC의 격리 self-host 하나를 띄우고 native 창에서 해당 서버 웹 주소를 엽니다. 기존 계정 등록/로그인 → 서재 읽기 → 위치 저장 → 로그아웃 → 다시 로그인까지 확인합니다.
2. 외부 페이지에는 로컬 파일·provider key·내장 서버 제어 등 native 권한을 부여하지 않습니다. 로컬 선택 화면은 기존 `main`, 외부 페이지는 별도 label로 분리하는 구성을 먼저 확인합니다.
3. 권한을 주지 않아도 Tauri 전역 객체 때문에 웹 UI가 native라고 판별할 수 있습니다. `detectPlatformRuntime`, 창 프레임, 수집기·provider·다운로드 호출이 실제 일반 서버 경로를 쓰는지 확인합니다. 필요한 경우 외부 웹 표시 모드에 한정한 작은 구분을 추가하고 일반 Tauri/Android 판별은 보존합니다.
4. 파일 선택·원본/백업 다운로드가 WebView 안에서 끝까지 동작하는지 확인합니다. 서버 웹 화면과 같은 동작이 기준이며 네이티브 파일 저장 계층을 새로 만들지 않습니다.
5. 외부 페이지가 실패하거나 로그인할 수 없어도 native 메뉴/로컬 창으로 돌아올 수 있어야 합니다. 돌아오기 동작에 외부 페이지의 IPC 호출을 요구하지 않습니다.

이 방식의 화면·기능 버전은 접속한 서버가 제공합니다. 앱에 포함된 최신 UI를 그 서버에 강제로 적용하거나, 접속을 위해 서버 DB를 자동 이전하지 않습니다. 지원되지 않는 서버라면 이유와 복귀 방법을 표시합니다.

**이 검증 전에는** bundled UI의 API 주소만 외부 주소로 바꾸지 않습니다. 현재 `same-origin` 요청과 `SameSite=Strict` cookie 때문에 `credentials: include`만으로 해결된다고 가정할 수도 없습니다.
범용 인증 프록시, 세션 복제, 새 bearer 로그인 API 또는 wildcard CORS/원격 native 권한 허용으로 범위를 키우지 않습니다.
권장안이 막히면 실패 원인과 가장 작은 대안을 먼저 설명하고 필요한 범위를 판단합니다. 임시 브라우저 열기를 완성된 앱 내 접속으로 표시하지 않습니다.

### B2. 선택·기억·서버 전환

- 선택 문구는 **'이 PC의 서재' / '기존 서버에 접속'**으로 합니다. 기존 서버를 골라도 작품을 복사·병합·가져오지 않습니다.
- 선택 정보는 설치 단위의 작은 설정 하나로 저장합니다. 예: `{ version: 1, mode: 'embedded' | 'remote', serverUrl?: string }`. 기존 설정 저장 방법을 확인해 재사용하고 DB schema나 서버 설정 항목을 추가하지 않습니다.
- 선택 기록이 없는 기존 설치는 지금처럼 내장 서버로 시작합니다. 로컬 설정/선택 화면에서 기존 서버를 선택할 수 있게 합니다. 저장된 remote 선택이 있으면 다음 시작에 `EmbeddedServerGate`를 mount하거나 내장 API·DB·worker를 시작하지 않습니다.
- 주소는 **서버 웹 주소**입니다. `/api` URL과 구별해 안내하고 정규화 규칙을 검사합니다. HTTP(S)만 허용하고 URL 내 아이디/비밀번호와 토큰 query를 저장하지 않습니다. 외부 HTTPS 및 기존 LAN/loopback HTTP 정책을 존중하고 인증서 검사를 끄지 않습니다.
- 로그인은 서버 웹 화면에서 합니다. 앱은 계정 비밀번호나 내장 서버 bootstrap token을 다른 서버로 전달하지 않습니다. 저장된 URL은 최근 선택일 뿐 같은 서버라는 증명이 아니며, 주소 변경 때 로그인 자격을 수동 이관하지 않습니다.
- 첫 구현의 **전환 적용 시점은 앱 재시작**입니다. 기존 `stop()`이 앱 종료를 전제로 하므로, 즉석 전환을 위해 프로세스 관리자부터 재설계하지 않습니다. 사용자는 선택을 저장하고 기존 종료 절차를 거쳐 다시 실행합니다.
- 가져오기/백업/재생 중 선택을 바꿔도 실행 중인 작업의 대상 서버는 바뀌지 않습니다. 즉시 종료·취소하지 말고 다음 시작에 적용됨을 표시합니다. 트레이 유지는 재시작이 아니므로 현재 내장 서버가 유지된다는 뜻을 분명히 합니다.
- remote 앱 종료는 화면만 닫습니다. 외부 서버에 shutdown을 보내지 않습니다. 로컬 공유 설정과 '서버와 종료' 문구는 실제 내장 서버가 실행 중일 때만 사용합니다.
- 외부 연결 실패/주소 오류 시 재시도·주소 수정·이 PC의 서재 선택으로 돌아갈 수 있어야 합니다. 실패를 감추려고 빈 로컬 서재로 자동 전환하지 않습니다.

### B3. 서버·세션 분리 검사

| 상황                                       | 기대 결과                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 저장된 remote 설정으로 실행                | 내장 API·DB·worker가 새로 실행되지 않음; 서버의 기존 책이 보임                                    |
| 잘못된 비밀번호·세션 만료                  | 서버의 기존 로그인 흐름; 서재 초기화나 복제 없음                                                  |
| 서버 A에서 B로 변경 후 재시작              | A의 token·쿠키 수동 전달 없음; A의 책/진행률/늦은 응답이 B 화면에 적용되지 않음                   |
| A와 B가 같은 호스트의 서로 다른 포트       | cookie는 포트로 격리되지 않는 점을 고려해 별도 WebView profile 등으로 인증 상태를 분리; 실제 검사 |
| 같은 서버에서 로그아웃 후 다른 계정 로그인 | 이전 계정 자료·캐시 노출 없음; 서버 쪽 작업을 임의로 다른 계정 작업으로 바꾸지 않음               |
| remote에서 local로 복귀                    | 기존 local profile의 책·주석·설정 유지; 새 빈 DB를 만들지 않음                                    |
| remote 창 종료/연결 단절                   | 기존 서버는 계속 실행; 복구 메뉴 접근 가능                                                        |
| 외부 페이지에서 native invoke 시도         | 파일/키/내장 서버 제어 권한 거부; remote 창 닫기·선택 복귀는 native 측 동작                       |

별도 창을 쓰면 브라우저 origin 격리와 창 수명을 활용합니다. 같은 bundled runtime을 쓰는 대안이라면 서버별 인증·요청 취소·캐시·object URL·poller 분리를 추가로 입증해야 하므로 비용 비교에 포함합니다.
재시작 적용 정책을 이유로 사용자 데이터를 삭제하거나 전체 IndexedDB를 비우지 않습니다.

**B 완료 기준:** 실제 앱 창에서 일반 계정으로 기존 서버를 사용하고, 서버 전환과 실패 복귀·데이터 보존을 확인합니다. 기본 웹·내장 서버·Android 기존 경로를 유지합니다. 새로운 서버 간 데이터 전송 API는 없습니다.

## 6. C — 최종 후보와 필요한 배포 검사

1. B의 기능별 검사가 통과하면 A의 Windows workflow에 직접 접속 시나리오를 추가하고 한 후보로 실행합니다. 두 서버 fixture는 전환·격리를 검사하기 위한 것이며 자동 복제 구현이 아닙니다.
2. 내장 서버의 기본 사용 흐름과 직접 접속 흐름을 둘 다 검사합니다. 검증되지 않은 단계를 제외해서 green으로 만들지 않습니다. 제품 범위가 달라진 assertion은 이유를 기록하고 바꿉니다.
3. installer가 필요한 후보에서만 `build_installer=true`로 기존 설치 검사를 실행합니다. 개발 도구를 PATH에서 숨긴 CI 검사는 완전히 깨끗한 Windows PC 검사를 대신하지 않으므로 증거 수준을 구분합니다.
4. 업데이트 검사는 식별된 이전 설치 후보로 임시 profile에 책·주석을 만든 후 새 후보로 열어 확인합니다. 소스 롤백과 DB 다운그레이드를 혼동하지 않습니다. 기존 profile 복사본으로 검사하고 설치 경로 변경 시 새 빈 서재로 보이지 않는지 확인합니다.
5. 필요한 백업 이전 형식 하나를 실제 fixture로 검사합니다. 지원되지 않는 옛 형식이 나오면 사용자에게 필요한 형식인지부터 확인합니다. 모든 converter와 전체 저장 구조를 선제적으로 고치지 않습니다.
6. 대용량 검증이 필요하면 기존 `smoke-embedded-large-import.mjs`를 후보 한 번에 사용합니다. 기본 fixture는 500 MiB 초과 CBZ이며 시간·공간이 필요합니다. Windows에서 메모리를 측정하지 않은 결과를 메모리 안전성 증거로 쓰지 않습니다.
7. 수집기 로그인·AI/TTS·고정 터널은 실제 사용할 연동과 테스트 계정/키가 준비된 것만 실행합니다. 유료 호출·별도 계정이 필요한 검증은 세션의 허용 범위를 따르고, 미실행 항목은 그대로 남깁니다.

공식 배포 전에는 기존 라이선스/재배포 고지 검사를 실행합니다. CI 성공·커밋·artifact 생성과 GitHub Release 게시·운영 배포는 별개입니다.

## 7. 로컬 검사와 실패 처리

문서만 바뀌면 제품 검사를 반복하지 않습니다. 구현 시 변경 영역에 맞게 실행합니다. 아래 목록을 모두 새 테스트로 다시 작성할 필요는 없습니다.

```bash
# 직접 접속 구현의 기본 회귀
corepack pnpm typecheck:web
corepack pnpm typecheck:server
node node_modules/vitest/vitest.mjs run src/platform/EmbeddedServerGate.test.tsx src/platform/EmbeddedServerSharing.test.tsx src/features/auth/self-host-auth-client.test.ts src/app/runtime/app-runtime.test.ts src/test/remote-sync-transport.test.ts
node --test scripts/desktop/embedded-sharing.test.mjs scripts/desktop/embedded-tunnel.test.mjs

# 공통 서버/저장 경로를 수정했을 때 추가
node node_modules/vitest/vitest.mjs run apps/server/test/client-sync-consistency.integration.test.ts apps/server/src/routes/sync apps/server/src/routes/sync.test.ts apps/server/src/routes/books.test.ts apps/server/src/server.security.test.ts apps/server/src/services/hosted-backup-service.test.ts apps/server/src/services/hosted-backup-storage-safety.test.ts apps/server/src/services/import-expected-base.integration.test.ts apps/server/src/services/import-page-reuse.integration.test.ts --maxWorkers=2
corepack pnpm check:server:production

# Rust/앱 명령을 수정했을 때 추가
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml --locked

# 마무리: 실제 변경 파일의 formatter/linter + 다음 공통 경계
corepack pnpm check:contract-boundaries
corepack pnpm check:public-source
git diff --check
```

새 선택 설정의 검증, 모드별 시작·종료, URL·세션 격리는 구현과 함께 필요한 회귀를 추가합니다.
통합 검사는 실제 PostgreSQL 및 object storage fixture가 실행됐는지 확인합니다. DB 환경 부재나 benchmark skip을 통과 건수에 더하지 않습니다.
실패 시 해당 코드·로그·최소 재현부터 확인합니다. 기존 mock 기대와 제품 동작 오류를 구분하며, 공통 계약을 바꿔 테스트를 통과시키기 전에 정상 클라이언트 영향을 검토합니다.

## 8. 작업 결과 기록과 인계

큰 구현을 시작하기 전에 사용자에게 **필요한 사용 흐름 → 현재 코드 재사용 → 변경할 범위 → 유지 비용**을 짧게 설명합니다. 이 계획을 넘어서는 기능은 필요성을 먼저 판단합니다.

| 단위                           | 상태      | 커밋 / 검사 증거 / 남은 문제                                              |
| ------------------------------ | --------- | ------------------------------------------------------------------------- |
| A 정리본 Windows 실행          | 완료      | 아래 실행 36118626358, `ea7fca5`; 실제 앱 창·별도 profile 백업 복원 통과  |
| B1 기존 웹 로그인 WebView 검증 | 완료      | 아래 Windows 실행 36126788910; 일반 로그인·원본 다운로드·native 명령 차단 |
| B2~B3 접속 선택·전환·격리      | 완료      | Windows 실행 36131029201에서 설정창 입력·재시작·가져오기·복귀 확인        |
| C 최종 후보 / 설치·업데이트    | 부분 완료 | 설치 후보 기동 통과; 기존 설치본 승계·공개 배포 고지 검사는 남음          |

각 단위의 코드 SHA, 검사 명령/통과·실패·skip, Windows run URL·`headSha`·artifact, 실제 확인한 기능, 미검증 항목을 기록합니다.
코드와 문서는 검토 가능한 단위로 커밋하고 같은 `desktop.md`와 이 문서를 갱신합니다. 로그에 인증값·사용자 파일을 포함하지 않습니다.

### A 실행 결과

- 첫 실행 [36117523041](https://github.com/west-truth/moya-reader/actions/runs/36117523041)은 `b7a7cca`에서 실제 앱 창의 독서·주석·백업 저장·트레이·재시작까지 통과한 뒤, smoke 스크립트의 `startEmbeddedServer` import 누락으로 별도 profile 복원에서 실패했습니다. 제품의 복원 오류로 간주하지 않았습니다.
- 검사 스크립트에 누락된 import 한 줄을 추가한 `ea7fca5`로 [36118626358](https://github.com/west-truth/moya-reader/actions/runs/36118626358)을 재실행해 전체 성공했습니다. artifact `app-smoke-result.json`은 `nativeBackupRestored: true`, `nativeLocalBackupRestored: true`, `nativeBookmarkRestart: true`, `trayMaintainsServer: true`, EPUB/PDF를 기록했습니다. 패키징 서버 읽기·재시작·EPUB/PDF 단계도 성공했습니다.
- 이 결과는 **정리본 내장 서버 후보**의 검증입니다. B의 외부 서버 접속, installer와 기존 설치본 업데이트는 이 run의 검사 범위에 없습니다.

### B 실행 결과

- 구현 코드 `6e347a0`의 [Windows 실행 36126788910](https://github.com/west-truth/moya-reader/actions/runs/36126788910)이 전체 성공했습니다. `app-smoke-result.json`의 `remoteWindowAccountLogin`, `remoteSelectionAndReturn`, `remoteFileImportAndBackup`가 모두 `true`입니다. 일반 계정 로그인·로그아웃·재로그인, 원본 다운로드 바이트, 외부 페이지의 native 명령 거부를 실제 외부 WebView에서 확인했습니다.
- 설치 설정이 없던 기존 사용자는 이 PC의 내장 서버로 시작합니다. 기존 서버를 선택하면 다음 앱 시작에 해당 서버의 별도 WebView profile에서 로그인합니다. 내장 서버와 로컬 작업은 시작하지 않으며, 로컬로 돌아온 뒤 기존 책·북마크가 유지됐습니다. 원격 서버에서 가져온 새 작품은 로컬 서재에 생기지 않았습니다.
- 같은 Windows 실행에서 로컬 공유·해제, TXT/EPUB/PDF 읽기, 주석, 백업 저장·복원, 트레이, 강제 종료 복구와 재시작도 통과했습니다. 외부 접속 주소는 공개 HTTP를 거부하고 HTTPS를 요구하며, 로컬·LAN·Tailscale HTTP는 허용합니다.
- 주소·계정 선택만 저장하며, 서버 간 작품 자동 복사·병합 API는 추가하지 않았습니다. 외부 서버와 앱의 UI 버전이 다를 때는 해당 서버가 제공하는 웹 화면이 사용됩니다.
- 검사 스크립트가 선택값을 직접 주입하던 부분을 실제 설정창의 라디오·주소 입력으로 바꾼 `4966302`의 [Windows 실행 36131029201](https://github.com/west-truth/moya-reader/actions/runs/36131029201)도 전체 성공했습니다. 이 실행의 `remoteSelectionAndReturn`, `remoteFileImportAndBackup`가 모두 `true`이며 패키징 서버 EPUB/PDF 검사도 통과했습니다. 연결 실패 화면의 주소 변경·재시도는 별도 React 회귀 검사로 확인했습니다.

### C 검증 중 확인한 경계

- `6e347a0`의 첫 설치 후보 [36127820072](https://github.com/west-truth/moya-reader/actions/runs/36127820072)은 설치 빌드 이전의 강제 종료 복구 검사에서 **최초 준비 90초 시간 초과**로 실패했습니다. 같은 SHA의 전체 Windows 실행 36126788910은 해당 검사를 통과했습니다. 복구 검사에 단계·프로세스 진단을 추가한 `c6dac1d`의 [재실행 36128734373](https://github.com/west-truth/moya-reader/actions/runs/36128734373)은 복구와 전체 앱·서버 회귀, 설치 후보 빌드 및 설치 후 기동까지 성공했습니다. 첫 시간 초과 원인은 재현되지 않아 미확정입니다.
- 재실행 산출물 `installer-smoke-result.json`은 `installedRelease`, `bundledServer`, `developerPathRemoved`가 `true`, `cleanMachine`이 `false`입니다. 설치 파일은 276,154,534바이트이며 CI 러너의 임시 설치 경로에서 앱·서버가 실행됐습니다. 물리적 새 PC 검증이나 공식 릴리즈 게시를 뜻하지 않습니다.
- `4966302`는 제품 구현을 바꾸지 않고 Windows smoke의 입력 동작과 실패 재시도 단위 검사만 추가했습니다. 따라서 위 설치 후보 검사는 같은 제품 코드의 근거이며, 새 Windows 실행 36131029201은 실제 UI 선택 경로의 별도 근거입니다.
- `corepack pnpm check:licenses`는 통과했습니다. `corepack pnpm check:licenses:release`는 기존 정책의 `7z-wasm` 대응 소스·재링크 제공, `libarchive-wasm` 바이너리/소스 확인, Cargo·Android 및 컨테이너·Python 의존성 목록, 최종 설치물 고지 검사 미완료로 **차단**됩니다. 설치 후보 검사는 공식 공개 배포 승인이 아닙니다.
- 후보 installer의 앱 식별자는 `app.moya.reader.embedded-candidate`이며 기본 Tauri 설정의 `com.local.noveldeskreader`와 다릅니다. 확인된 이전 GitHub Release 설치물이 없어 자동 업데이트·기존 profile 승계를 검증하지 못했습니다. 이전 설치본의 자료를 건드리지 않는 별도 후보로 취급합니다.

다음 워커 전달문:

> `refactor/desktop-single-server`에서 `docs/platforms/desktop.md`와 이 문서의 A·B·C 결과를 읽고 시작한다. 직접 접속과 CI 설치 후보는 이미 검증했으므로 다시 구현하지 않는다. 다음 배포 판단에는 실제 이전 설치본·profile 식별, 자료 승계 검사, `check:licenses:release` 차단 항목 해소가 필요하다. 실제 사용할 기존 백업·연동 계정이 확인된 범위만 추가 검증한다. 서버 간 자동 복제와 과거 W01~W12는 재개하지 않는다.

### 2026-09-25 추가 코드 검토

- 검토 기준 `888bf42`. 기존 Windows 검사는 같은 버전의 서버와 정상 기동 경로를 확인했으며 아래 실패 조건을 검증하지 않았습니다.
- **구버전 서버 호환성:** `cb833c8`의 실제 플랫폼 판별 함수를 외부 HTTP WebView 조건으로 실행하면 `browser`가 아닌 `tauri-desktop`이 됩니다. 앱의 native 권한은 차단되어 있어도 구버전 화면은 네이티브 경로를 잘못 선택합니다. 서버 웹 화면의 작은 호환 선언을 확인해 지원하지 않는 화면을 열기 전에 업데이트/일반 브라우저 안내를 표시하도록 보완했습니다. 구버전 앱 호환을 새로 구현한 것은 아닙니다.
- **내장 서버 시작 실패:** 실패 화면에서 서재 선택 버튼이 없음을 React 검사로 재현했습니다. 준비·실패 화면에도 기존 창 프레임을 사용해 외부 서버를 다음 시작 대상으로 저장할 수 있도록 수정했습니다. 실패 상태에서 서재 runtime은 생성하지 않습니다.
- **외부 모드의 로컬 작업 의존성:** 앱 setup이 외부 모드에서도 로컬 workflow journal을 열고 있어 손상 시 선택 화면 이전에 시작이 실패할 수 있었습니다. embedded 빌드에서는 이 초기화를 로컬 서버 시작 명령으로 이동했습니다. 기존 일반 네이티브 빌드의 초기화는 유지했습니다. 손상된 journal로 실제 Windows 앱을 여는 검사는 아직 하지 않았습니다.
- 수정 후 React/플랫폼 검사 39개, embedded 빌드 Rust 검사 102개 통과(실제 Vertex 계정이 필요한 2개 제외). 웹 타입·변경 TSX 린트·embedded Cargo check 통과. 외부 접속 검사는 실제 로컬 HTTP 응답으로 현재 HTML 수용, 구형 HTML/JSON/redirect/과대 응답 거부를 확인했습니다.
- 다음 Windows 후보에서 호환 선언이 없는 서버의 안내, 내장 기동 실패 화면의 서재 선택, 외부 모드에서 손상된 로컬 journal과의 격리를 확인해야 합니다. 기존 Windows 성공을 이번 수정본의 성공으로 인용하지 않습니다. 서버 DB·동기화·백업 경로는 이번 검토에서 변경하지 않았습니다.

### 진행률 표시 보완 (2026-09-25)

- 기존 카드·회차 행의 원 중앙에 해당 단계의 실제 퍼센트를 표시합니다. 모바일의 `다운로드 중` 문구는 유지합니다. 다운로드 원은 기존 취소 버튼이며, 진행률 상세보기 버튼·팝오버는 만들지 않습니다. 사용하지 않던 원형 진행률의 상세보기 버튼 API도 제거했습니다.
- 전송과 처리 단계는 두 색으로 구분하되 상태 문구를 함께 유지합니다. 총량이 없으면 회전 표시를 쓰고, 작업이 확정되기 전에는 전체 완료로 표시하지 않습니다. 서버가 확정 후 서재를 갱신하는 동안에는 `마무리 중`입니다.
- 서버의 APK/Mangayomi 이미지 다운로드는 검증해서 받은 장수/전체 장수를 기존 준비 요청에 연결했습니다. 진행 정보만 별도 인증된 GET으로 조회합니다. 메모리에 최대 64개, 작업 중 1시간·마무리 후 60초를 유지하며, DB 테이블이나 새로운 작업 실행기는 추가하지 않습니다. 완료·취소 후 늦은 응답은 무시하고 구버전의 진행률 조회 실패는 원래 다운로드를 재실행하지 않습니다.
- 스트리밍 EPUB/이미지 압축 가져오기는 미리 확인한 이미지 자산 수(표지 포함)를 저장 단계의 분모로 전달합니다. 다운로드 장수와 저장 자산 수는 별도 단계입니다.
- 백업 화면에는 기존 패널 안에 작업·단계·처리량을 표시합니다. 서버 수신 바이트와 복원 항목 수를 전달하고, 파일 저장 스트림이 닫히기 전에는 성공으로 처리하지 않습니다. ZIP 전체 크기를 모르면 받은 바이트만 표시하며, 브라우저에 넘긴 다운로드는 기존대로 브라우저에서 완료를 확인합니다.
- 검증: 원 클릭 취소, 상세보기 버튼 부재, 늦은 조회 응답·구버전 조회 실패, 인증·진행 기록 제한, 실제 준비 요청 중 조회, 백업 저장 종료 대기, 스트리밍 자산 수와 실제 산출물 일치 검사를 통과했습니다. 관련 다운로드·가져오기·백업 회귀, 웹/서버 타입, 변경 파일 lint, CSS 및 공통 계약 검사도 통과했습니다. APK catalog Node 검사 15개 통과.
- 실제 구성요소와 전체 앱 CSS를 사용한 Chromium 화면 검사에서 320/390/1366px의 회차 다운로드·백업 패널에 가로 넘침이 없고, 모바일 상태 문구 표시와 다운로드 원 클릭 취소를 확인했습니다. 이번 변경의 Windows WebView·실서비스 대용량 다운로드 검증은 아직 수행하지 않았습니다. 이전 Windows 실행 증거와 구분합니다.

### PR 전 재검토 (2026-09-26)

- 기준: `origin/main`의 `40ee131`부터 `refactor/desktop-single-server`의 `888bf42`까지 117개 커밋과 현재 미커밋 변경. main은 이 브랜치의 조상이며 검토 당시 열린 PR은 없습니다. 서버 간 복제는 제거된 상태이고, 내장 self-host 또는 외부 self-host 한 곳에 접속하는 구조를 유지합니다.
- **재현·수정 — 일시적인 상태 조회 실패:** 서버가 계속 실행 중이어도 native 상태 조회가 한 번 실패하면 `EmbeddedServerGate`가 독서 화면을 unmount해 화면 상태를 잃었습니다. 조회만 실패한 경우 기존 독서 화면과 페이지 상태를 유지하고 기존 알림 UI로 재확인 중임을 표시합니다. native가 실제 종료를 보고하면 실패 화면으로 전환합니다. 수정 전 페이지 보존 검사 실패와 수정 후 두 경로 통과를 확인했습니다.
- **재현·수정 — Rust 품질 검사:** 일반 빌드에서 사용하지 않는 embedded tray 함수의 조건부 컴파일을 호출부와 맞췄습니다. 외부 HTML 호환성 HTTP 검사는 요청 헤더를 끝까지 읽도록 수정했습니다. 일반·embedded 구성의 `clippy --all-targets -- -D warnings`가 모두 통과했습니다.
- 검증: 실제 PostgreSQL을 사용하는 동기화·가져오기·백업 이전을 포함한 22개 파일의 **183개 검사 통과**, 선택적 대용량 benchmark 3개 제외. 수정 후 앱 gate·서재 선택·공유·플랫폼 검사 **35개 통과**(앞선 검사와 일부 중복). 추가 진행률·백업 클라이언트·EPUB/압축 검사 **44개 통과**. Rust embedded 단위 검사 **102개 통과**, 외부 계정이 필요한 2개 제외. Node 공유·터널·APK 검사 **20개 통과**.
- 웹·서버·스크립트 타입 검사, 수정한 gate 파일 린트, CSS·공통 계약·공개 소스 경계, 서버 production build 검사를 통과했습니다. 로컬 로그는 `/tmp/moya-pr-review-*.log`에 있으며 Windows 실행 증거를 대신하지 않습니다.
- **최신 Windows 실행은 미완료:** 앞선 36131029201은 `4966302`의 성공 기록입니다. 이후 구버전 웹 화면 사전 차단, 기동 실패 시 서재 선택, 외부 모드에서 로컬 journal 초기화 지연, 진행률 변경과 이번 gate 수정까지 확인한 결과가 아닙니다. 이 변경을 포함한 정확한 후보 SHA로 실제 창·기동/종료·외부 접속·다운로드 취소·백업을 확인해야 합니다.
- 현재 `desktop-embedded.yml`은 수동 실행 또는 이전 `feat/desktop-embedded-selfhost` 브랜치 push로 실행됩니다. 일반 PR 품질 검사만 통과해도 내장 서버 패키징·실제 Windows 앱 검증까지 완료된 것으로 해석하지 않습니다.
- 외부 서버의 웹 화면에 `browser-v1` 호환 선언이 없으면 앱은 업데이트 또는 일반 브라우저 사용을 안내합니다. 모든 과거 릴리즈 서버를 native WebView에서 그대로 지원한다는 뜻이 아닙니다.
- 소스 배포 라이선스 검사는 통과했고 공개 설치본 배포 검사는 앞서 C에 적은 자료 미완료로 계속 차단됩니다. 기존 정식 설치본의 profile 승계·업데이트 검증도 남아 있습니다. 검토 PR과 공식 릴리즈 판단을 분리합니다.
- 이번 재검토에서는 PR 생성·커밋·push·Windows CI 실행을 하지 않았습니다. 수정과 검토 결과는 작업 트리에 남겼습니다. 검토용 PR 준비는 가능하지만 최신 Windows 실행 전에는 앱 검증 완료나 병합 준비 완료로 표시하지 않습니다.

## 2026-09-26 설정 정리·표지 저장 수정

- 데스크톱 상단의 서재 선택·공유 버튼을 제거했다. 서재 선택은 **설정 → 동기화**, 접속 허용·해제와 주소·QR은 **설정 → 원격 접속**에서 조작한다. 서재 선택은 다음 앱 시작에 적용한다.
- self-host 웹도 원격 접속 탭에서 현재 서버 주소·QR을 제공한다. localhost는 다른 기기용 QR로 안내하지 않는다. native 터널 제어와 내장 인증 정보는 데스크톱 provider 안에만 둔다.
- native 보조 버튼의 미정의 `secondary-btn`을 공통 `ghost-btn`으로 교체했다. 배경·테두리·hover와 44px 높이를 적용하고 서재 선택 radio 항목도 선택 상태를 구분했다.
- 다운로드한 소스 표지를 저장할 때 `fetch(blob:)`가 native CSP에 막히는 오류를 Chromium에서 재현했다. `connect-src`에 `blob:`만 추가했다. 실제 `persistSourceCover`의 디코딩·hash·저장 호출을 검사하는 `scripts/desktop/source-cover-csp.test.mjs`를 추가했다. 외부 페이지의 native 접근 권한을 늘리지 않았다.
- 공개 굿툰 Mangayomi 0.1.9에서 목록과 표지 3장의 수신은 확인했다. 이미 다운로드한 책의 표지를 소급 일괄 변경하지 않으며, 기존 동일 회차 다운로드/표지 보완 경로를 다시 실행할 수 있다.
- 구버전 self-host 화면에는 native WebView 호환 표식이 없다. 호환 검사와 origin 격리는 유지하며, 기존 서버 선택 화면에 **일반 브라우저에서 열기**를 추가했다. 주소는 동일하게 검증하고 토큰은 URL에 넣지 않는다. 보고된 개별 서버는 검토 환경에서 TCP 연결 timeout으로 실제 인증·화면 접속을 확인하지 못했다.
- 검증: 관련 컴포넌트·표지 단위 검사 27개, CSP 브라우저 검사, 웹 타입 검사, native 구성 Rust check, 변경 파일 린트·CSS 검사 통과. 1280px/390px 화면 배치와 가로 넘침을 확인했다. 이번 Windows 산출물은 아래 build-only 경로로 만들며 Windows 실사용 smoke 통과를 의미하지 않는다.

### 테스트 EXE만 만들기

기존 PR이나 전체 CI 결과를 기다릴 필요 없이 원하는 ref에서 실행한다.

```sh
gh workflow run desktop-embedded.yml --ref refactor/desktop-single-server -f build_only=true
```

이 경로는 `desktop-test-build.yml`을 호출해 Windows 런타임과 release 설치 EXE만 만든다. debug 앱 빌드·단위/실사용 smoke·설치 검증은 생략한다. 결과는 실행의 **moya-windows-x64-build-only** artifact이며 14일 보관한다. 일반 검증 경로는 `build_only=false`로 유지한다. GitHub Release에 공개하지 않는다.

### 연결 진단·회차 방향키·픽셀 스크롤 (2026-09-26)

- 외부 서버 연결 실패 시 기존 화면에서 원인과 실패 단계·오류 코드·HTTP 상태 또는 전송 오류를 펼쳐 보고 복사한다. 구형 웹 화면의 호환성 거부와 네트워크 timeout을 구분한다. 서버 응답 본문·인증 헤더는 기록하지 않으며 잘못된 URL의 자격 증명을 진단에 표시하지 않는다.
- 공통 회차 페이지 버튼에 좌우 방향키를 연결했다. 현재 보이는 최상위 목록만 처리하며 입력창·slider·다른 dialog·조합/수정 키·키 반복은 제외한다. 기존 클릭 경로의 페이지 범위 검사와 스크롤 위치 보존을 재사용한다. 데스크톱과 self-host 웹에서 같은 UI를 사용한다.
- 픽셀 스크롤을 기존 5~~60px/초에서 **5~~1,200px/초**로 확대했다. 슬라이더와 직접 입력에 실제 단위를 표시한다. 기존 기본값/저속 설정은 유지하고 텍스트·만화의 픽셀 속도는 별도로 저장한다. 줄/페이지/가림 읽기 속도는 기존 범위로 유지해 고속 픽셀 설정이 다른 방식에 전달되지 않게 했다.
- 검증: 관련 React/읽기 검사 48개, 웹 타입·변경 파일 lint·CSS 검사 통과. Rust 원격 화면 호환성·origin 검사 2개 통과. 실제 Chromium에서 방향키 이동, 입력창/dialog 키 격리, 1,200px/초 조절과 390px 가로 넘침 부재를 확인했다. Windows 산출물은 build-only로 별도 생성하며 실제 Windows 조작 검증과 구분한다.
