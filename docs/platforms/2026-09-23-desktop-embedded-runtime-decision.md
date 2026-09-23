# 내장 서버 P0 실행 구성과 검증

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
- 1차 성공 측정: 첫 시작 3,357ms, 재시작 1,107ms. Linux 개발 의존성을 사용한 값이며 Windows 앱의 수치로 사용하지 않는다.

Windows 결과와 구성요소별 최종 동봉 크기/메모리는 CI 산출물 `inventory.json`, `smoke-result.json` 확인 뒤 기록한다. EDB 원본 ZIP에는 pgAdmin 등이 포함되어 332,441,502바이트지만, 후보에는 서버 bin/lib/share와 관련 라이선스만 넣는다. 이 다운로드 크기를 앱 배포 크기로 표시하지 않는다.

## 다음 완료 조건

- [ ] Windows payload의 같은 사용 흐름과 구성요소별 크기·메모리 기록.
- [ ] Tauri 앱의 자동 실행·연결·상태 표시, 사용자에게 setup token 수동 입력을 요구하지 않는 로컬 bootstrap.
- [ ] 다른 실제 기기 접속: 공유 설정·인증·HTTP/HTTPS와 세션 정책 검증.
- [ ] 강제 종료 후 lock/자식 프로세스 복구와 업데이트, 트레이/종료 UX. 현재 P0는 비정상 종료로 남은 lock을 자동 삭제하지 않는다.
- [ ] 원형 숫자 퍼센트 UI를 보관 브랜치에서 선별 연결하고 서버 처리량으로 표시.
- [ ] 전체 기능/백업/이전/동기화의 후속 계획 수행.

Windows proof payload는 실행 구성을 검증하는 산출물이다. 라이선스 고지·대응 소스·모든 필수 기능/런타임을 확인하기 전 사용자 배포물로 공개하지 않는다.
