# 내장 self-host 데스크톱: 다음 작업 실행 지침

작성: 2026-09-24. 초기 코드 확인 기준: `d537b26`. 현재 수집기 검증 기준: `775a9ff`, 실제 앱 검증 기준: `9fe6097`. **다음 작업은 B의 남은 장애 경계와 초기 복제 이후의 변경 전송·일반 UI다.** 이 문서는 기존 구현 계획을 실행 단위로 구체화한다. 제품 구현을 완료했다는 기록이 아니다.

## 0. 시작 위치와 읽을 순서

- 작업 디렉터리: `/home/koho5155/Docker_Services/.worktrees/moya-desktop-selfhost`
- 작업 브랜치: `feat/desktop-embedded-selfhost`
- 시작 시 `git status --short`와 현재 HEAD를 확인한다. 기준 커밋으로 reset하지 않는다. 이후 추가된 변경을 보존한다.
- `/home/koho5155/Docker_Services/moya-reader`와 보관 worktree는 이번 작업 디렉터리가 아니다.
- 기준 문서: [전체 구현 계획](2026-09-23-desktop-embedded-selfhost-plan.md) → 이 문서 → 필요한 작업의 코드. [실행 증거](2026-09-23-desktop-embedded-runtime-decision.md)와 [기능 지원표](2026-09-24-desktop-feature-support.md)는 상태 확인용이다.
- 옛 IndexedDB 확장 계획은 구현 기준이 아니다. 보관 브랜치 전체 merge/cherry-pick을 하지 않는다.

고정 구조: **공통 웹 UI → 기존 self-host API/worker → PostgreSQL·Redis·서버 파일 저장소**. 앱은 필요한 프로세스·설치·창을 관리한다. 데스크톱 서재의 별도 IndexedDB 정본, 새 수집 엔진, 새 백업 형식을 만들지 않는다.

## 1. 이미 끝난 작업 — 재구현하지 않기

| 기능 | 현재 상태와 증거 |
| --- | --- |
| Windows 내장 서버/앱 | 동봉 Node·PostgreSQL·Redis, Remote reader 연결, 시작·종료·트레이·재시작 통과 |
| 설치 후보 | NSIS 약 129MB. 설치 후 개발 도구 PATH 없이 서버 실행/종료 통과. 새 PC 필수 구성 미설치 상태는 미검증 |
| 외부 접속 | 켤 때 Quick Tunnel 기본 선택. LAN/Tailscale IPv4·고정 터널 옵션, 공통 QR/로그인 구현. 실제 물리 타 기기 검증은 별도 |
| 복구 | OS 프로필 잠금, 소유권 확인 후 launcher 강제 종료 복구 통과. 작업 도중 전원 차단/공유 프로세스 잔존까지 모두 검증한 것은 아님 |
| 숫자 진행률 | `TaskProgressRing`, 가져오기·책장·SourceHub 연결. 확인된 바이트/이미지 수 사용. 미확정 총량에 가짜 퍼센트 금지 |
| 실제 파일 흐름 | Linux 529MiB 만화 가져오기→이미지 읽기→원본 해시 일치. Linux/Windows 브라우저 EPUB/PDF 읽기·원본 보존 통과 |
| 서버 백업 | 새 서버 프로필로 복원 후 작품 ID·원본·독서 위치·재시작 보존 통과. 기존 로컬 백업 이전과 구분 |

Windows 초기 성공: [35911331300](https://github.com/west-truth/moya-reader/actions/runs/35911331300), 코드 `3e747f1`. 이후 `d537b26`의 과거 업로드 세션 파일명 누락 방어는 로컬 타입 검사·관련 31개 검사로 확인했다.

## 현재 진행 기록

- **A1~A3:** [Windows 실행 35929350327](https://github.com/west-truth/moya-reader/actions/runs/35929350327), 코드 `775a9ff`에서 기존 수집기 인증·프레임·세션 복구 27개 검사, 동봉 Chromium 실행, 패키징된 수집기의 인증 gateway, 공개 작품 metadata·표지, 수집기 부재 시 서재 유지, 실제 앱 WebView gateway 요청을 통과했다. 실제 계정 로그인 성공까지 증명한 것은 아니다.
- **크기·설치:** [Windows 실행 35932538748](https://github.com/west-truth/moya-reader/actions/runs/35932538748), 코드 `62514e5`에서 설치 후보 276,188,625 bytes의 설치·개발 도구 PATH 제거 후 동봉 서버 시작·종료가 통과했다. 런타임 payload는 862,344,665 bytes, 수집기 서비스·라이선스 60,525,066 bytes, Chromium 286,993,460 bytes다. 필수 구성이 없는 새 PC는 아직 검증하지 않았다.
- **B 실제 앱:** 같은 `62514e5` 실행의 앱 창 검사에서 native TXT 검색·북마크, EPUB/PDF 읽기, WebView의 백업 만들기 버튼→ZIP 바이트 저장→새 프로필 3권·원본·북마크 복원, 공유·재시작이 통과했다. 검사에서는 WebView의 저장 파일 선택기를 대체해 실제 ZIP 바이트를 수집했으며 **OS 저장 대화상자 조작 자체는 자동 검증하지 않았다.** `1d8e368`은 숨겨진 검색 입력을 선택한 검사 오류, `f9022cb`은 WebView에서 다운로드 이벤트를 기다린 검사/저장 경계 오류였다. 스트림을 파일에 쓰고 완료를 확인하도록 수정했다.
- **B 공유·포트 단절:** LAN/Tailscale 주소가 사라졌을 때 listener를 내리고, Cloudflare 프로세스가 살아 있어도 공개 경로가 3회 연속 실패하면 공유 상태를 내린다. 합성 네트워크 단절 검사에서 로컬 API 유지까지 통과했다. 저장된 API 포트가 점유되면 명시적인 오류와 원본 프로필 보존을 Linux 합성 검사로 확인했다. [Windows 회귀 검사 35945180361](https://github.com/west-truth/moya-reader/actions/runs/35945180361), 코드 `6fed1f8`도 통과했다. 실제 네트워크를 물리적으로 끊은 검증은 남았다.
- **B 문서 주석:** 원격 PDF 화면의 주석이 브라우저 IndexedDB에만 남던 결함을 서버 API와 원격 repository로 수정했다. [Windows 실행 35946363523](https://github.com/west-truth/moya-reader/actions/runs/35946363523), 코드 `fba22b5`에서 native PDF 주석 저장→재시작→백업 복원이 통과했다. 종전 브라우저 IndexedDB에만 남은 주석은 자동 이전하지 않았다.
- **B AI/TTS·저장 공간:** 내장 서버 연결 시 `createAppRuntime`이 기존 서버 provider control·분석 gateway를 선택한다. runtime/TTS controller 단위 검사는 통과했다. 공급자 키가 없어 외부 AI/TTS 실요청은 미검증이다. 백업 staging 도중 `ENOSPC`가 발생하면 부분 파일을 정리하고 임시 공간 부족 오류를 표시하도록 했다. 작은 실패 주입 검사를 통과했다.
- **C0/D0:** [로컬 백업 매핑 조사](2026-09-24-local-backup-mapping-audit.md)와 [서버 동기화 계약 조사](2026-09-24-server-sync-contract-audit.md)를 작성했다. 서버 ZIP의 문서·듣기 상태 누락은 `3d3bb9b`에서 보완했다.
- **C1 기본 ZIP 이전:** 로컬 v1 ZIP을 기존 서버 staging/복원 경계에서 검사·변환한다. TXT/EPUB/PDF/CBZ fixture의 원본·자산·회차·문단과 PDF 페이지 주석을 검증했다. 실제 PostgreSQL/객체 저장소에서 TXT 원본·독서 위치·북마크와 재적용 skip/replace/copy를 통과했다. [Windows 앱 창 검사 35948632633](https://github.com/west-truth/moya-reader/actions/runs/35948632633), 코드 `9fe6097`에서 파일 입력→로컬 ZIP 검사 안내→복원 버튼→서버 원본·위치·북마크 확인도 통과했다. OS 파일 선택 대화상자 조작은 검사 범위 밖이다. 매핑되지 않은 자료가 있으면 부분 복원하지 않고 거부한다. 지원/거부 범위는 [C0 문서](2026-09-24-local-backup-mapping-audit.md)의 구현 기록을 따른다. 기존 사용자의 다양한 ZIP과 프로세스 중단/재시도 검증은 남았다.
- **D1 독서 위치 첫 범위:** 동일 book/source hash/active revision/chapter ID를 가진 두 독립 서버에서 새 독서 위치만 교환하는 API 실행기를 추가했다. 서버 DB의 방향별 cursor, 암호화한 상대 계정 session, 15초 백그라운드 실행을 사용한다. 두 실제 PostgreSQL DB/HTTP 서버에서 A→B, 재시작 후 B→A, 같은 시각 충돌·미지원 북마크·세션 만료를 검사했다. 이 첫 범위 뒤 빈 서재 최초 복제를 추가했다. 공통 UI 연결은 없다. 세부 계약은 [D0/D1 기록](2026-09-24-server-sync-contract-audit.md)을 따른다.
- **D1 저장 원자성 보완:** 독서 위치 REST 저장·삭제와 sync event를 한 DB transaction으로 묶었다. 사건 기록 실패를 실제 DB에 주입하여 위치 변경이 남지 않는지 확인했고, 같은 ID에 다른 내용의 재요청은 409로 거부한다. 관련 서버 회귀 검사 33개와 타입 검사가 통과했다. 다른 자료의 writer는 이 검사로 보장되지 않는다.
- **Windows 복구 재검증:** [실행 35952587865](https://github.com/west-truth/moya-reader/actions/runs/35952587865), 코드 `52fb8d7`에서 PostgreSQL 소유권 조회의 제한된 재시도와 launcher 강제 종료 후 동일 프로필 복구가 통과했다. 같은 실행의 실제 앱 창, 공유·재시작, 패키징 서버 독서도 통과했다. 소유권을 확인할 수 없을 때 기존 자료를 보존하고 복구를 중단한다.
- **현재 Windows 코드 검증:** [실행 35953318186](https://github.com/west-truth/moya-reader/actions/runs/35953318186), 코드 `abb418c`에서 내장 런타임·수집기·복구·실제 앱 창·공유·재시작·패키징 서버 독서·EPUB/PDF가 통과했다. 이 push 실행은 설치본 생성 옵션을 켜지 않았으므로 새 설치 파일의 최초 설치 증거는 아니다.
- **D1 빈 서재 최초 복제:** 기존 서버 백업 스트림을 계정 session으로 받아 대상 서버의 기존 staging/복원에 연결한다. 빈 대상 서재에 원본·자산·읽던 위치 등을 처음 복사하고 이후의 새 독서 위치 사건은 기존 D1 실행기가 교환한다. 복원과 수신 cursor는 같은 DB commit으로 처리한다. 두 실제 DB/HTTP 서버에서 원본 누락 실패→대상 보존→재시도→원본 바이트와 신규 위치 전달을 검사했다. 일반 UI, 계속 추가되는 작품·원본과 다른 항목의 증분 동기화는 아직 없다.

## 2. 실행 순서

| 순서 | 작업 | 산출물 / 종료 조건 |
| --- | --- | --- |
| A1 | 수집기 요청을 선택한 서버로 연결 | 앱·웹이 기존 서버 gateway 사용, 기존 standalone 경로 보존, 인증 회귀 검사 |
| A2 | 기존 수집기를 내장 서버 패키지에서 실행 | 사용자 Python 설치 없이 metadata/표지 실제 요청, 중복 실행·종료 검사 |
| A3 | 수집기 로그인 브라우저 연결 | 기존 remote-frame 기능 재사용, 브라우저 제공 방식 확정·실행 검사·크기 보고 |
| B | 기존 기능·실패 복구의 남은 검증 | 아래 B 표의 작은 사용 흐름별 결과와 재현된 오류만 수정 |
| C0 → C1 | 기존 로컬 백업을 서버로 이전 | 기본 ZIP 변환·DB 복원·앱 창 파일 입력 통과. 다양한 사용자 자료·OS 파일 선택 대화상자·프로세스 중단/재시도 검사 남음 |
| D0 → D1… | 독립 서버 간 동기화 | 지원표와 동일 작품의 신규 독서 위치 양방향 실행기, 빈 서재 초기 snapshot·원본 복제 통과. 이후 작품·원본 변경, 주석·삭제·충돌 해결/UI 확대 남음 |
| E | 일반 배포 확인 | 새 PC 필수 구성, 라이선스/대응 소스, 실제 타 기기 검증 |

A1~A3은 하나의 수집기 연결 작업을 검토 가능한 단위로 나눈 것이다. A1만 끝내고 “수집기 완료”로 표시하지 않는다. C0/D0은 필요한 설계 산출물이 명시된 작업이며, 확인되지 않은 데이터 계약을 구현자가 추측해서 채우지 않는다.

## A1. 기존 수집기 gateway를 앱에서도 사용

### 확인된 현재 코드

- `src/main.tsx`: 내장 서버의 URL/토큰을 reader runtime에 주입하지만 수집기 factory에는 platform만 전달한다.
- `src/platform/webnovel-metadata-collector.ts`: `tauri-desktop`이면 항상 `NativeWebNovelMetadataCollectorClient`를 선택한다. 웹 gateway는 빌드 환경값과 동일 origin을 기준으로 결정한다.
- `src/App.tsx`: 일반 설치 확장은 Remote runtime에서 이미 `RemoteInstalledExtensions`를 선택한다. 이 분기를 다시 만들 필요가 없다.
- `apps/server/src/routes/webnovel-metadata-collector-gateway.ts`: `/api/integrations/webnovel-metadata` 아래 health/resolve/batch/cover/auth 경로가 이미 있다.
- `compose.metadata-collector.yaml`: 기존 self-host는 별도 수집기 프로세스의 URL을 `WEBNOVEL_METADATA_COLLECTOR_URL`로 API에 전달한다.

### 변경 지시

1. 수집기 factory가 명시적인 실행 중 서버 연결(API base URL, 인증을 얻는 함수)을 받을 수 있게 한다. 구체적 TypeScript 타입 이름은 기존 코드에 맞춰 정한다.
2. 명시적인 서버 연결이 있으면 platform보다 우선하여 기존 gateway client를 만든다. 내장 서버 연결은 `main.tsx`의 `connection`에서 전달한다. 기존 브라우저 self-host의 세션 쿠키 경로와 서버 연결 없는 standalone 데스크톱 경로를 유지한다.
3. Tauri UI origin과 API origin이 다르므로 기존 웹용 동일 origin 검사만 무조건 풀지 않는다. 명시적으로 주입된 서버 연결 경로를 분리하고, 인증 헤더는 그 gateway의 URL에만 붙인다. 토큰을 localStorage·URL·로그에 기록하지 않는다.
4. A2의 수집기 세션 토큰을 API만 전달할 수 있도록 `apps/server/src/config.ts`와 gateway를 보완한다. 새 선택적 환경값은 `WEBNOVEL_METADATA_COLLECTOR_SESSION_TOKEN`으로 한다. 미설정인 기존 Docker 동작은 유지한다.
5. API→수집기 요청에는 설정된 `X-Moya-Collector-Token`을 사용한다. 외부 클라이언트가 보낸 같은 이름의 헤더나 서재 소유자 토큰을 그대로 전달하지 않는다. 모든 gateway 작업에 동일하게 적용한다.

### 완료 검사

- `src/platform/webnovel-metadata-collector.test.ts`: 명시적 서버 연결이면 native invoke를 호출하지 않음, 정확한 API 경로/인증, 일반 웹의 쿠키 사용, standalone 경로 보존.
- `apps/server/src/routes/webnovel-metadata-collector-gateway.test.ts`: 내부 토큰 전달, 클라이언트 헤더로 덮어쓰기 불가, 토큰 미설정 Docker 호환성, 기존 인증 차단 유지.
- 수집기 자체가 없는 상태는 기존 capability/오류로 표시한다. 연결 실패를 숨겨 성공으로 반환하지 않는다.
- 이 단계는 Python 수집 로직·DB·서재 저장 방식을 변경할 이유가 없다.

## A2. 기존 수집기 실행 파일을 함께 제공

### 재사용할 파일

- 빌더: `scripts/build-webnovel-metadata-collector-sidecar.mjs` (`collector:bundle`). 기존 PyInstaller/Python 의존성·라이선스 목록 생성을 재사용한다.
- 실제 서비스: `services/webnovel-metadata-collector/app/sidecar.py`, `app/main.py`. `--host 127.0.0.1 --port <port>`, `MOYA_COLLECTOR_DATA_DIR`, `MOYA_COLLECTOR_SESSION_TOKEN`이 이미 있다.
- 연결할 실행기: `scripts/desktop/build-embedded-runtime.mjs`, `embedded-server.mjs`, `embedded-recovery.mjs`, `embedded-inventory.mjs`.
- 기존 동작 참고: `src-tauri/src/metadata_collector.rs`. 새 후보에서 이 native 실행기와 서버 실행기를 동시에 시작하지 않는다.

### 변경 지시

1. Windows CI 빌드 환경에서 기존 수집기 빌더를 실행한다. **개발/CI의 Python은 허용되지만 설치 사용자에게 Python·pip를 요구하지 않는다.** 기존 출력 폴더를 라이선스와 함께 runtime의 `collector/`로 복사하고 manifest에 상대 실행 경로 `collectorExecutable`을 추가한다.
2. 현재 설치 설정의 `collector-sidecar/ : null`만 지워서 옛 경로를 켜는 방법으로 끝내지 않는다. `embedded-server/` 아래에 한 번 포함하고 수집기도 같은 내장 서버 실행기가 소유하게 한다.
3. 실행기는 수집기용 loopback 포트, 프로필 하위 `metadata-collector/` 데이터 폴더, 별도 무작위 내부 토큰을 준비한다. API에는 수집기 URL과 A1의 내부 토큰을 환경으로 전달한다. 이 토큰을 native `ready` 응답이나 웹에 전달하지 않는다.
4. 실행 파일 존재만으로 준비 완료로 판단하지 않는다. 내부 토큰을 사용한 `/health`의 service/API version을 확인한다. 실행 실패/시간 초과는 수집기 기능의 명확한 오류로 보여 주고 이미 준비된 서재 읽기를 불필요하게 막지 않는다.
5. 정상 종료·트레이 유지·초기화 중 취소·launcher 강제 종료에서 수집기와 그 브라우저의 소유권/정리 경로를 연결한다. 현재 recovery가 API/worker만 기다리는 사실을 확인하고 collector를 추가한다. 다른 수집기/사용자 브라우저를 이름으로 일괄 종료하지 않는다. PID만 보고 임의 프로세스를 죽이지 않는다.
6. runtime inventory에 실제 수집기 파일 크기를 포함한다. 기존 약 129MB 설치본 크기를 새 후보의 크기로 재사용하지 않는다.

### 완료 검사

- 새 smoke: `scripts/desktop/smoke-embedded-collector.mjs` (생성할 파일). 새 검증 프로필만 사용한다.
- 실제 패키징된 실행 파일 시작→기존 API gateway의 인증된 health→공개 작품 metadata/표지 한 건→종료/재시작. 사이트 일시 장애와 패키지/인증 실패를 구분해 기록한다.
- 자동 검사에는 결정적인 응답 fixture를 사용하되 **mock 통과만으로 실제 사이트 검증 완료를 주장하지 않는다.** 유료 계정·개인 로그인 정보는 사용하지 않는다.
- native 앱과 별도 로그인 브라우저가 같은 gateway를 사용하며, 앱에서 기존 `desktop_metadata_collector_start`를 따로 호출하지 않음을 확인한다.
- 공개 공유 listener에 수집기 포트를 직접 노출하지 않는다. 미인증 gateway 요청은 거절되고 내부 토큰은 응답에 나타나지 않아야 한다.
- 설치본 실행 검사에서는 PATH에서 개발용 Python도 제거한다. 프로세스가 남지 않는 정상/강제 종료 검사를 포함한다.

## A3. 로그인 브라우저 — 일반 metadata와 별도 완료 검사

기존 `app/auth_session.py`는 native 모드에서 시스템 Chrome/Edge를 찾고, remote 모드에서는 Playwright Chromium을 사용한다. `--check-runtime`은 driver 초기화 검사이므로 Chromium 실행 성공과 같지 않다.

1. 기존 self-host의 remote-frame UI/API, `MOYA_COLLECTOR_REMOTE_AUTH`, 서버 `WEBNOVEL_METADATA_COLLECTOR_REMOTE_AUTH_ENABLED`를 재사용한다. 앱과 외부 브라우저에서 같은 서버 수집기 세션을 사용한다.
2. 구현 시작 시 **Chromium을 제공하는 구체적 방법과 추가 크기**를 짧게 확정한다. 기본 검토안은 기존 Playwright 버전에 맞는 브라우저를 앱 runtime에 동봉하고 프로필은 데이터 폴더에 두는 것이다. 첫 사용 자동 준비를 택한다면 다운로드 실패/재시도·버전 일치까지 작업 항목에 포함한다. 어떤 안이든 사용자에게 Python/pip/Playwright 수동 설치를 요구하지 않는다.
3. Docker의 Linux/Xvfb 시작 명령을 Windows에 그대로 복사하지 않는다. 기존 headless remote-frame 경로로 실제 창/프레임·입력을 검사한다. 사이트별 인증 통과는 자동으로 보장하지 않는다.
4. `tests/test_remote_auth_browser.py`, `test_remote_auth_browser_live.py`, `test_companion_service.py`의 조건을 읽고 필요한 검사만 실행한다. 일반 health, 로그인 브라우저 열기/닫기, 프레임·입력, 세션 유지/삭제를 구분한다. 실제 계정 없이는 사이트 로그인 성공을 완료 처리하지 않는다.

## B. 남은 기능·복구 검증 — 실패가 확인된 경계만 수정

| 사용자 흐름 | 기존 코드/검사 출발점 | 합격 조건 |
| --- | --- | --- |
| native EPUB/PDF·검색·주석 | `smoke-embedded-app.mjs`, `smoke-embedded-formats.mjs`, `src/features/fixed-document`, Remote repositories | 실제 WebView에서 열기·검색·주석 저장→재시작 보존. 브라우저 검사를 native 검사로 대체 표기하지 않음 |
| 백업 저장 UI | `src/features/backup/useBackupController.ts`, `remote-backup-repository.ts`, `routes/backups.ts` | 설치 앱에서 저장된 ZIP을 새 프로필에 복원. 다운로드 시작 알림만으로 완료 판정하지 않음 |
| 작업 중 종료/복구 | `embedded-server.mjs`, `embedded-recovery.mjs`, `smoke-embedded-recovery.mjs`, 기존 import job | 실제 처리 중 launcher 종료→재실행 후 작업 상태 확인. 완료 원본 손상/중복 작품 없음. 재시도 가능 상태 확인 |
| 디스크 부족/포트 충돌 | 기존 object store·업로드·시작 검사 | 새 테스트 프로필에서 제한된 fixture/fault injection. 오류가 보이고 기존 원본 유지. 실제 디스크를 가득 채우지 않음 |
| 공유 연결 단절 | `embedded-tunnel.mjs`, `EmbeddedServerSharing.tsx` | 연결기 종료뿐 아니라 프로세스가 살아 있는 네트워크 단절 상태를 오인 표시하지 않음. 해제 후 로컬 읽기 유지 |
| AI/TTS·일반 확장 | `src/app/runtime/app-runtime.ts`, `src/App.tsx`, 서버 provider/extension 경로 | 서버 실행 선택, 중복 native host 없음, 실제 지원 범위 기록. API 키가 없으면 외부 공급자 실검증은 대기로 기록 |

물리 타 기기·고정 Cloudflare 도메인처럼 현재 환경만으로 끝낼 수 없는 검사는 필요한 환경과 재현 절차를 적고 다른 독립 작업을 계속한다. 테스트를 통과시키기 위해 기능을 숨기거나 인증 검사를 없애지 않는다.

## C0/C1. 기존 로컬 자료 이전

**현재 상태: C0 계약 조사 완료, C1 기본 ZIP 변환·복원과 실제 앱 창 파일 입력 검증 완료. 미지원 자료는 명시적으로 거부한다.**

- C0 읽을 코드: `src/storage/indexeddb-backup-repository.ts`, `src/repositories/backup-repository.ts`, `apps/server/src/services/hosted-backup-archive.ts`, `hosted-backup-service.ts`, 기존 import/sync의 ID·revision 변환 함수.
- 같은 `noveldesk-backup` v1 명칭만 보고 호환된다고 가정하지 않는다. 서버 parser는 `backend: hosted`를 요구한다.
- C0 산출물: 실제 local 백업 fixture의 각 entry → 서버 테이블/객체 키 매핑표. ID/revision·원본·표지·텍스트/문서 anchor·읽던 위치·주석·설정·미전송 변경 각각의 보존/변환/미지원 이유를 적는다. 보관 브랜치 중간 스키마가 실제 배포됐다는 증거가 없으면 기본 지원 범위에 넣지 않는다.
- C1: 확정한 local 백업 읽기/검증 변환만 기존 서버 staging/복원 경계에 추가한다. 중간 native 파일 저장 제품이나 새 IDB 이전 저장소를 만들지 않는다. 원본 백업과 기존 프로필을 보존한다.
- 완료 검사: 같은 작은 백업을 새 프로필과 충돌 있는 프로필에 적용, 중단/재시도·skip/replace/copy 정책, 원본 해시·참조 무결성·독서 상태·주석 검증. 작업 완료를 확인하기 전 원본을 삭제하거나 자동 전환하지 않는다.

## D0/D1… 독립 서재 동기화

**현재 상태: D0 계약 조사, D1 독서 위치 첫 범위와 빈 서재 초기 백업 복제 통과. 이후 작품·원본 변경과 다른 항목의 증분 복제는 미구현.**

1. D0 출발점: `src/sync/contract.ts`, `types.ts`, `local-outbox-sync-service.ts`, `apps/server/src/routes/sync/*`, 서버 book source/asset·snapshot·삭제 경로. 웹의 기존 동기화 계약을 유지한다.
2. 산출물은 `항목 / 기존 writer / push·pull 경로 / revision·ID 규칙 / 중복 처리 / 충돌 정책 / 부족한 부분 / 확인 테스트` 표다. 독서 위치·주석·메타데이터·원본/자산·작품 추가/삭제·AI/TTS와 인증·cursor·최초 snapshot을 각각 채운다. 파일이 있다는 것만으로 지원으로 표시하지 않는다.
3. D1 첫 결과: **작품 ID와 내용이 같은 두 합성 서버**에서 읽던 위치 변경을 기존 계약으로 양방향 교환. 서버 DB에 cursor/재전송 상태를 보존하고 중복 전송·재시작을 검사한다. 이 단계는 동일 작품 사전 존재 조건이며 서재 전체 복제 완료가 아니다.
4. 빈 서재의 초기 작품/원본 복제는 기존 서버 백업 경로로 구현했다. 다음 단위에서 이후 작품/원본 변경, 주석/메타데이터, 삭제/충돌, 오프라인 재전송을 표의 의존 순서로 확장한다. 수정 충돌에서 원본을 임의로 덮어쓰거나 시각 하나로 모든 데이터를 승자 결정하지 않는다. 기존 규칙이 없는 항목은 데이터 보존과 명시적 충돌을 우선하는 계약을 먼저 적는다.
5. 연결 상대는 우선 서재당 하나. 실행 주체는 내장 서버이며 UI를 닫아도 지속된다. 클라이언트용 `LocalOutboxSyncService`를 데스크톱 IDB 정본을 만드는 데 사용하지 않는다.
6. 공개 gateway는 native owner bearer를 차단한다. 이를 해제하여 서버 동기화를 연결하지 않는다. 기존 계정 인증/갱신 경로의 서버 간 사용 가능성을 D0에서 확인한다. 연결 비밀은 서버의 기존 보호 저장 경계를 사용하고 UI/URL/로그에 노출하지 않는다.
7. UI에서 `서버 서재 열기`와 `이 PC에 보관하고 동기화`의 실제 동작을 구분한다. 기존 서버 접속 성공을 오프라인 복제 성공으로 보고하지 않는다.

## E. 배포·비용·검증 규칙

- 새 Windows에서 VC/WebView가 없는 최초 설치, 수집기/브라우저를 포함한 총 설치 크기, 재배포 고지/대응 소스, 물리 타 기기 접속을 기록해야 일반 배포 완료다. 현재 CI runner 성공으로 대체하지 않는다.
- 수정한 단위의 좁은 검사→실제 작은 사용 흐름→필요한 Windows 검사 순서로 한다. 529MiB 검사를 관련 변경 없이 반복하지 않는다.
- Windows installer cold build는 오래 걸렸다. 플랫폼과 무관한 문서/단위 검사마다 설치본을 새로 만들지 않는다. 수집기 실행·패키징 변경을 한 단위로 묶어 실제 Windows 검사하고, 실패 경계를 확인한 뒤 재실행한다.
- 기존 CI: `.github/workflows/desktop-embedded.yml`. 설치 검사는 `gh workflow run desktop-embedded.yml --ref feat/desktop-embedded-selfhost -f build_installer=true`. 실행한 SHA와 성공/실패 단계를 기록한다. 개인 서재를 공유용 fixture로 쓰지 않는다.
- 단위 검사 예시(A1): `node node_modules/vitest/vitest.mjs run src/platform/webnovel-metadata-collector.test.ts apps/server/src/routes/webnovel-metadata-collector-gateway.test.ts`. 변경에 맞게 client/broker 기존 검사만 추가한다.
- 타입 검사: `corepack pnpm typecheck:web`, `corepack pnpm typecheck:server`. 문서만 바꾸면 제품 전체 테스트를 다시 돌리지 않는다.
- 한 단위가 끝날 때 `변경 파일 / 사용 가능해진 기능 / 실제 검사와 SHA / 아직 미검증인 조건 / 다음 작업 ID`를 갱신한다. 큰 새 framework나 전면 교체가 필요하다고 판단하면 기존 경로가 실패한 구체적 증거와 대안 범위를 먼저 설명한다.

## 다음 세션에 전달할 짧은 지시문

> `/home/koho5155/Docker_Services/.worktrees/moya-desktop-selfhost`의 `feat/desktop-embedded-selfhost`에서 작업한다. 전체 구현 계획, 이 인계 문서, C0/D0/D1 조사 문서를 읽는다. A1~A3과 `9fe6097`까지의 Windows 실제 앱 검사를 재구현하지 않는다. C1 기본 로컬 ZIP 변환은 서버 staging에 있으며 미지원 행을 조용히 버리지 않는다. C1의 다양한 사용자 자료 검증을 넓히고, D1 빈 서재 초기 복제 이후 작품/원본 변경과 일반 UI, B의 남은 종료·디스크 부족·AI/TTS·실제 공유 단절, E 배포 검증을 진행한다. 기존 self-host와 공통 UI를 재사용하며 데스크톱 IDB 정본이나 새 수집 엔진을 만들지 않는다. 작업 단위별 검증 결과와 다음 작업 ID를 기록한다.
