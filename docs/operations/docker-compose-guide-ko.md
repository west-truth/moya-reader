# 모야 Docker Compose 배포 가이드

Status: current
Last verified: 2026-08-29

## 권장 서버 환경

모야의 기준 서버 환경은 **x86-64 Ubuntu + Docker Engine + Docker Compose v2**이다. 공개 배포 저장소의 GitHub
검사는 Ubuntu 24.04에서 실행하며, Node 빌드와 서버 런타임 이미지는 Ubuntu와 같은 glibc 계열인 Debian
Bookworm slim을 사용한다. 로컬 TTS 이미지도 Debian 기반이다. 따라서 Windows에서 만든 네이티브 패키지
목록이나 Alpine/musl 패키지가 서버용 라이선스 기준본에 섞이지 않는다.

Ubuntu가 아닌 Linux에서도 같은 Compose 구성을 실행할 수는 있지만, 문서와 공개 CI가 직접 보장하는 기준은
Ubuntu x86-64이다. Docker를 사용하면 호스트 운영체제와 컨테이너 운영체제는 별개이며, 모야의 Node 컨테이너는
의도적으로 Debian/glibc 계열을 사용한다.

이 문서는 Docker를 처음 사용하는 사람도 모야 서버를 실행할 수 있도록 단계별로 설명한다. 명령은
프로젝트 루트, 즉 `compose.yaml`이 있는 폴더에서 실행한다.

## 먼저 배포 방식을 고른다

| 목적                        | 사용할 구성                                        | 권장 대상                                |
| --------------------------- | -------------------------------------------------- | ---------------------------------------- |
| 한 컴퓨터에서만 사용        | `compose.yaml`                                     | 처음 설치, 개인용 테스트                 |
| 표지·작품 정보 자동 채우기  | `compose.yaml` + `compose.metadata-collector.yaml` | 웹소설 정보 익스텐션을 쓸 때             |
| 19세 작품 인증 검색         | 위 구성 + `compose.metadata-collector-auth.yaml`   | 서버 전용 로그인 브라우저가 필요할 때    |
| 서버와 로컬 한국어 TTS 사용 | `compose.yaml` + `compose.local-tts.yaml`          | 외부 TTS 비용 없이 CPU 음성 합성을 쓸 때 |
| WireGuard/LAN/인터넷 접속   | `compose.yaml` + `compose.public.yaml`             | 개인 서버, 동일 호스트의 HTTPS 프록시 뒤 |
| 외부 접속과 로컬 TTS 사용   | 위 세 파일 모두                                    | 개인 서버와 CPU TTS를 함께 운영할 때     |

처음에는 기본 구성으로 정상 실행을 확인한 다음 TTS나 외부 공개를 추가하는 편이 가장 쉽다.

현재 서버 인증은 여러 사용자가 가입하는 SaaS가 아니라 기존 `DEFAULT_USER_ID` 책장에 연결되는 **소유자 계정
하나**를 사용한다. 첫 브라우저에서만 `READER_AUTH_TOKEN`을 초기 설정 코드로 입력해 아이디·비밀번호를 만들고,
이후 기기는 그 계정으로 로그인한다. 로그인 세션은 서버 DB와 HttpOnly cookie에 30일간 보존되어 다음 접속부터
자동 복구된다. `READER_AUTH_TOKEN`은 자동화와 비상 복구용으로 계속 보관하지만 일반 브라우저 설정에는 저장하지
않는다. 불특정 다수가 가입하는 공개 서비스 구성은 아니다.

## 어떤 컨테이너가 실행되는가

기본 구성은 다음 서비스를 실행한다.

| 서비스               | 역할                                  | 호스트 공개 여부           |
| -------------------- | ------------------------------------- | -------------------------- |
| `web`                | 웹 화면과 `/api` 프록시               | `127.0.0.1:8080`           |
| `api`                | 책장, Reader, 동기화, 백업 API        | 직접 공개하지 않음         |
| `worker`             | 파일 가져오기와 AI/TTS 작업           | 공개하지 않음              |
| `postgres`           | 책장과 독서 데이터의 기준 저장소      | 공개하지 않음              |
| `redis`              | 작업 큐                               | 공개하지 않음              |
| `minio`              | 원본 파일, 문서 자산, TTS 오디오 저장 | Console만 `127.0.0.1:9001` |
| `tts-model`          | 선택형 로컬 한국어 TTS                | Compose 내부에서만 사용    |
| `metadata-collector` | 선택형 웹소설 표지·작품 정보 수집기   | Compose 내부에서만 사용    |

컨테이너를 다시 만들어도 데이터가 유지되도록 PostgreSQL, Redis, MinIO와 서버 데이터는 Docker named
volume에 저장된다.

## 1. 준비 사항

필요한 항목은 다음과 같다.

- Docker Desktop 또는 Docker Engine
- Docker Compose v2: `docker compose version`으로 확인
- Git으로 받은 모야 프로젝트
- 기본 구성은 호스트 메모리 8 GB 이상 권장
- 로컬 TTS까지 실행하면 호스트 메모리 12~16 GB 권장
- 책과 TTS 캐시를 저장할 충분한 디스크 공간

메모리 수치는 강제 최소값이 아니라 현재 컨테이너 상한을 고려한 권장값이다. PDF/압축 파일 가져오기와
TTS 합성이 겹치면 순간 사용량이 커질 수 있다.

먼저 Docker가 실행 중인지 확인한다.

```bash
docker version
docker compose version
```

`docker version`에서 Server 항목을 읽지 못하면 Docker Desktop 또는 Docker Engine을 먼저 시작해야 한다.

## 2. 환경 설정 파일 만들기

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Linux 또는 macOS:

```bash
cp .env.example .env
```

이후 `.env`를 텍스트 편집기로 연다. `.env`는 비밀번호와 API 키가 들어갈 수 있으므로 Git에 커밋하면
안 된다.

`COMPOSE_PROJECT_NAME`은 PostgreSQL·Redis·MinIO 등의 named volume 이름을 결정한다. 새 설치는 예제의
`moya-reader`를 그대로 유지한다. 이미 실행 중인 설치는 폴더를 옮기거나 `-p` 옵션을 바꾸기 전에
`docker compose ls`에서 현재 project 이름을 확인하고, 그 이름을 `.env`의 `COMPOSE_PROJECT_NAME`에 적은
뒤에 이동한다. 이 값이 바뀌면 기존 volume이 삭제되는 것은 아니지만 새 빈 volume으로 부팅되어 데이터가
사라진 것처럼 보일 수 있다.

### 개인 컴퓨터에서 먼저 시험할 때

처음 로컬 실행만 확인하려면 기본값으로 시작할 수 있다. 장기간 사용할 서버라면 **첫 기동 전에** 아래처럼
PostgreSQL과 MinIO 내부 자격증명을 정한다.

`.env.example`은 실수로 공개용 개발 자격증명을 재사용하지 않도록 이 세 비밀번호/사용자 값을 비워 둔다.
기본 loopback Compose는 빈 값에 개발용 fallback을 적용하지만, `compose.public.yaml`은 값이 없으면 시작 전에
실패한다.

```dotenv
POSTGRES_USER=noveldesk
POSTGRES_PASSWORD=충분히긴영문숫자비밀번호
POSTGRES_DB=noveldesk
DATABASE_URL=

MINIO_ROOT_USER=noveldesk-storage
MINIO_ROOT_PASSWORD=충분히긴영문숫자비밀번호
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
```

`DATABASE_URL`이 비어 있으면 Compose가 `POSTGRES_*` 값으로 내부 접속 주소를 만든다. `S3_ACCESS_KEY_ID`와
`S3_SECRET_ACCESS_KEY`가 비어 있으면 각각 `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`를 그대로 사용한다.
따라서 같은 비밀번호를 두 군데에 중복 입력해 서로 어긋나게 만들 필요가 없다. 외부 PostgreSQL이나 S3를
사용할 때만 `DATABASE_URL` 또는 `S3_*`를 직접 채운다. URL 인코딩 문제를 피하려면 내부 PostgreSQL
비밀번호에는 긴 영문과 숫자 조합을 쓰는 것이 간단하다.

PostgreSQL volume이 이미 초기화된 뒤에는 `.env`의 `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`만
바꾸면 안 된다. PostgreSQL 컨테이너의 초기화 변수는 빈 data directory에만 적용되므로, 기존 DB 계정은
그대로인데 API만 새 비밀번호로 접속해 중단된다. 운영 중 비밀번호를 교체할 때는 먼저 DB 안의 계정
비밀번호를 `psql`로 변경하고, 그 다음 `.env`를 같은 값으로 바꾼 뒤 API와 worker를 다시 생성한다. 실행 전
volume snapshot 또는 `pg_dump`를 남기고, `docker compose logs api postgres`에서 새 접속이 성공했는지
확인한다. 데이터가 있는 상태에서 이 문제를 해결하려고 `docker compose down -v`를 사용하면 안 된다.

예를 들어 현재 DB 사용자가 `noveldesk`라면 다음처럼 컨테이너 안의 `psql`에서 대화형 비밀번호 변경을
실행한다. 새 비밀번호가 shell history에 남지 않는 방식이다.

```bash
docker compose exec postgres psql -U noveldesk -d noveldesk
```

`psql` prompt에서 `\password noveldesk`를 실행하고 두 번 입력한 뒤 `\q`로 나온다. 이어서 `.env`의
`POSTGRES_PASSWORD`를 같은 값으로 바꾸고 다음 순서로 확인한다.

```bash
docker compose up -d --force-recreate api worker
docker compose logs --tail=100 api
curl http://127.0.0.1:8080/ready
```

Provider API 키를 UI에 저장할 계획이라면 `PROVIDER_SECRET_ENCRYPTION_KEY`도 고정하는 편이 복구하기
쉽다. PowerShell에서는 다음 명령으로 32바이트 키를 만들 수 있다.

```powershell
$bytes = New-Object byte[] 32
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
$generator.GetBytes($bytes)
[Convert]::ToBase64String($bytes)
$generator.Dispose()
```

Linux/macOS에서는 다음과 같이 만든다.

```bash
openssl rand -base64 32
```

출력값을 `.env`의 `PROVIDER_SECRET_ENCRYPTION_KEY=` 뒤에 붙인다. 비워 두어도 서버가 `server-data`
volume에 개인 키를 만들지만, 해당 volume을 잃으면 저장된 Provider 자격증명을 복호화할 수 없다.

## 3. 기본 서버 시작

먼저 Compose 파일을 해석할 수 있는지 확인한다.

```bash
docker compose config --quiet
```

오류가 없으면 이미지를 만들고 서비스를 시작한다.

```bash
docker compose up -d --build
```

상태를 확인한다.

```bash
docker compose ps
docker compose logs --tail=100 api
```

브라우저에서 다음 주소를 연다.

- 모야: `http://127.0.0.1:8080`
- MinIO 관리 화면: `http://127.0.0.1:9001`

간단한 상태 확인:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/ready
```

Windows에서 `curl` 사용이 불편하면 브라우저에서 두 주소를 직접 열어도 된다. `/health`는 API 프로세스와
데이터베이스의 기본 생존 상태를, `/ready`는 데이터베이스·Redis queue·MinIO·worker heartbeat를 함께
확인한다. `/ready`가 성공하고 `docker compose ps`에서 주요 서비스가 `healthy` 또는 `running`이면 파일
가져오기까지 받을 준비가 된 것이다.

### 표지·작품 정보 수집기를 함께 실행하기

`설정 → 익스텐션 → 웹소설 표지·작품 정보`를 self-host Web에서도 사용하려면 선택형 override를 추가한다.

```bash
docker compose -f compose.yaml -f compose.metadata-collector.yaml config --quiet
docker compose -f compose.yaml -f compose.metadata-collector.yaml up -d --build
```

외부 접속 구성에서도 같은 override를 마지막에 더하면 된다.

```bash
docker compose -f compose.yaml -f compose.public.yaml -f compose.metadata-collector.yaml up -d --build
```

수집기는 호스트 포트를 열지 않는다. 브라우저 요청은 기존 Moya `/api`로 들어오고 API가 Compose 내부의
`metadata-collector:8000`으로 필요한 health·검색·표지 요청만 전달한다. 따라서 Caddy, nginx, Traefik,
Nginx Proxy Manager 중 무엇을 쓰든 외부 프록시는 기존처럼 Moya Web 주소 하나만 전달하면 된다. 수집기용
도메인, 포트, Custom Location이나 브라우저 공개 API 주소를 추가하지 않는다.

override를 사용하지 않으면 익스텐션 연결만 `사용할 수 없음`으로 표시된다. 책장, Reader, 가져오기,
동기화와 나머지 서버 기능은 그대로 동작한다. 다시 끌 때는 base 구성으로 API를 재생성하고 수집기만 내린다.

```bash
docker compose up -d --force-recreate api
docker compose -f compose.yaml -f compose.metadata-collector.yaml stop metadata-collector
```

기본 수집기는 공개 메타데이터와 표지만 지원한다. 19세 인증 검색도 필요하면 auth override를 **마지막에** 추가한다.

```bash
docker compose \
  -f compose.yaml \
  -f compose.metadata-collector.yaml \
  -f compose.metadata-collector-auth.yaml \
  up -d --build
```

외부 접속 구성은 `compose.public.yaml` 다음에 두 collector override를 같은 순서로 추가한다. auth image는
Playwright/Chromium을 포함해 첫 빌드가 더 오래 걸리고 기본 memory limit는 `1536m`, shared memory는 `1gb`다.
기본 배포에는 포함되지 않으며 연결하지 않아도 Library, Reader, 동기화와 공개 metadata 검색에 영향이 없다.

Moya 설정의 익스텐션 카드에서 플랫폼 로그인 화면을 열면 전용 서버 Chromium 화면이 Moya 안에 표시된다. 별도
domain, port, WebSocket, NPM Custom Location은 필요 없다. 입력은 기존 로그인된 Moya HTTPS 연결을 거쳐 전용
브라우저로 전달되지만 앱 설정이나 DB에는 저장되지 않는다. browser profile/cookie는 private
`metadata-collector-data` volume에만 남고 Cloud Vault나 일반 기기 동기화에 포함되지 않는다. 공용 PC나 신뢰할
수 없는 평문 HTTP에서는 사용하지 말고, HTTPS·loopback 또는 신뢰하는 WireGuard 경로에서만 로그인한다.

현재 self-host는 소유자 계정 하나와 인증 profile 하나를 전제로 한다. `로그인 완료`는 해당 플랫폼을 검색 대상으로
켜는 동작이며 실제 성인 인증 성공을 자동 판정하지 않는다. 검색 결과가 계속 비어 있거나 session이 만료되면 다시
로그인하고, 서버를 폐기하거나 계정을 바꿀 때는 UI의 `로그인 세션 삭제`로 저장 profile도 제거한다.

수집기는 DB·Redis·MinIO와 분리된 전용 Docker network를 사용한다. 원격 로그인 browser는 내부 host와 공인 주소가
아닌 literal/DNS 결과를 차단하고 Service Worker와 WebSocket을 사용하지 않는다. 이는 실수와 일반적인 SSRF를 줄이는
앱 경계이며, Docker host가 민감한 사설망에 접근할 수 있는 배포라면 host firewall/egress 정책도 함께 적용한다.

### 서버에 올린 원본 소설 다운로드

서버 책장은 업로드한 TXT, Markdown, EPUB, PDF, ZIP/CBZ, RAR/CBR, 7z/CB7 원본 파일을 MinIO에 그대로
보관한다. 책장에서 작품을 선택한 뒤 오른쪽 작품 정보의 `원본 다운로드`를 누르면 원래 파일명과 형식으로
저장된다. 좁은 모바일 화면에서는 작품을 먼저 연 뒤 작품 정보 화면의 `원본 다운로드`를 사용한다.

모야는 이 원본 파일을 애플리케이션 수준에서 암호화하거나 다시 인코딩·압축하지 않는다. 다운로드
응답은 업로드한 바이트와 동일하며, 서버는 MinIO 객체를 메모리에 전부 조립하지 않고 스트리밍한다. PDF와
고정 레이아웃 Reader가 사용하는 HTTP Range 요청도 같은 원본 객체를 사용한다.

원본이 평문으로 저장된다는 뜻이지 외부 공개 시 인증과 HTTPS를 끈다는 뜻은 아니다. public override에서는
다른 API와 동일하게 Bearer 토큰이 필요하며, 인터넷 구간은 반드시 HTTPS로 보호한다. 디스크 자체의 암호화가
필요하다면 모야가 아닌 Docker 호스트 또는 MinIO 운영 계층에서 별도로 설정한다.

## 4. 로컬 TTS를 함께 실행하기

로컬 TTS는 필수 서비스가 아니다. 현재 제공하는 `tts-model`은 Compose 연결을 바로 시험할 수 있도록
만든 MeloTTS Korean CPU 레퍼런스 구현이다. 상용 음성 품질을 보장하는 모델 선택 기능과는 구분해야
한다.

선택 모델의 source/Python 빌드가 실패해도 서재 서버를 사용할 수 있도록 한 번에 모두 빌드하지 않는다.
핵심 서버를 먼저 시작하고, `tts-model` 이미지만 별도로 빌드한 뒤 성공했을 때 override 환경을 적용한다.

```bash
docker compose -f compose.yaml -f compose.local-tts.yaml config --quiet
docker compose up -d --build
docker compose -f compose.yaml -f compose.local-tts.yaml build tts-model
docker compose -f compose.yaml -f compose.local-tts.yaml up -d --no-build
docker compose -f compose.yaml -f compose.local-tts.yaml logs -f tts-model
```

두 번째 명령이 실패해도 첫 번째 명령으로 시작한 Web/API/worker는 계속 동작한다. 원인을 고쳐 모델 build를
다시 실행한 뒤에만 세 번째 명령을 실행한다.

첫 실행에서는 모델을 내려받으므로 준비에 몇 분 이상 걸릴 수 있다. 다운로드한 모델은
`local-tts-models` volume에 남아서 다음 시작에 재사용된다. `tts-model`은 선택형 degraded dependency라서
모델 다운로드나 health check가 실패해도 API와 worker는 먼저 시작하며, 책장·Reader·TXT/EPUB/PDF 가져오기는
계속 사용할 수 있다. 모델이 준비되기 전 TTS 요청만 명시적으로 실패하므로 `tts-model` 로그를 확인한 뒤
다시 실행하면 된다.

이 override를 사용하면 API와 worker의 기본 TTS provider가 `local-endpoint`로 바뀌며, 두 서비스는
Compose DNS 이름을 사용해 다음 내부 주소로 연결한다.

```text
http://tts-model:9010/synthesize
```

포트 `9010`은 호스트나 인터넷에 공개되지 않는다. `.env`의 아래 값은 특별한 이유가 없으면 그대로 둔다.

```dotenv
LOCAL_TTS_PROVIDER_DEFAULT=local-endpoint
LOCAL_TTS_PROVIDER_ENABLED=local-endpoint
MELOTTS_DEVICE=cpu
MELOTTS_LANGUAGE=KR
```

현재 sidecar는 `melotts-korean` 한 모델을 실행한다. `TTS_LOCAL_ENDPOINT_MODEL_ID` 이름만 바꾼다고 다른
모델이 자동 설치되는 것은 아니다. 다른 모델을 사용하려면 동일한 `/voices`, `/synthesize` 계약을 구현한
별도 이미지로 `tts-model` 서비스를 교체하면 된다.

## 5. WireGuard, LAN 또는 인터넷에서 접속하기

기본 구성은 안전을 위해 loopback에만 열린다. WireGuard/LAN/인터넷 중 어느 경로든 다른 기기에서 접속하게
할 때는 다음 조건을 적용한다.

1. Caddy, nginx 또는 Traefik이 HTTPS를 종료한다.
2. 첫 계정 초기 설정과 비상 복구에 쓸 긴 `READER_AUTH_TOKEN`을 설정한다.
3. 첫 기동 전에 `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`를 개발 기본값이 아닌 값으로 정한다.
4. `compose.public.yaml`을 함께 사용한다.
5. 인터넷 공개라면 도메인 DNS와 80/443 방화벽을 구성한다.

WireGuard 전용이면 공개 DNS나 인터넷 443 개방은 필요 없다. nginx의 `listen`을 서버의 WireGuard 주소로
제한하거나 방화벽에서 `wg0`로 들어오는 443만 허용한다. 예를 들어 WireGuard 주소가 `10.20.0.1`이면 예제의
`listen 443 ssl http2`를 `listen 10.20.0.1:443 ssl http2`로 바꿀 수 있다. 원격 브라우저의 secure-context
기능을 유지하려면 WireGuard 안에서도 신뢰할 수 있는 내부 인증서나 정상 도메인 인증서를 사용하는 편이
좋다.

첫 계정용 초기 설정 코드 생성 예시:

PowerShell:

```powershell
$bytes = New-Object byte[] 32
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
$generator.GetBytes($bytes)
($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
$generator.Dispose()
```

Linux/macOS:

```bash
openssl rand -hex 32
```

`.env`에 결과를 입력한다.

```dotenv
READER_AUTH_TOKEN=생성한긴토큰
POSTGRES_PASSWORD=충분히긴영문숫자비밀번호
MINIO_ROOT_USER=noveldesk-storage
MINIO_ROOT_PASSWORD=충분히긴별도영문숫자비밀번호
```

공개 Compose를 시작한 뒤 첫 브라우저에서 모야 주소를 열면 `내 계정 만들기` 화면이 나온다. 위 값을 `초기
설정 코드`에 한 번 입력하고 소유자 아이디·비밀번호를 만든다. 기존 서버 책장은 새 사용자를 만들지 않고 기존
`DEFAULT_USER_ID`에 그대로 연결된다. 두 번째 기기부터는 초기 설정 코드 없이 아이디·비밀번호만 사용하며,
로그아웃하거나 30일 세션이 만료되기 전까지 자동 로그인된다. 공개 프록시를 열기 전에 loopback 또는 WireGuard
안에서 첫 계정을 만드는 편이 안전하다. 첫 가져오기나 계정 생성 후 `DEFAULT_USER_ID`를 바꾸면 기존 책장과
소유자 계정의 기준 사용자가 달라지므로 서버가 인증을 차단한다. 운영 중에는 이 값을 변경하지 않는다.

public override는 위 저장소 자격증명도 required interpolation으로 검사한다. 비어 있으면 Compose가
컨테이너를 만들기 전에 멈춘다. 기존 volume을 public override로 전환할 때는 새 값을 임의로 만들지 말고
현재 PostgreSQL/MinIO가 실제로 사용하는 값을 먼저 적는다. PostgreSQL 비밀번호를 바꿀 때는 앞의 DB 내부
변경 절차를 따른다.

웹 화면과 `/api`가 같은 nginx 주소를 사용하면 same-origin이므로 `CORS_ALLOWED_ORIGINS`를 별도로 설정할
필요가 없다. 별도로 호스팅한 웹 앱이나 다른 브라우저 origin에서 API를 직접 호출할 때만 정확한 origin을
쉼표로 구분해 추가한다. 경로나 와일드카드는 넣지 않는다.

```dotenv
CORS_ALLOWED_ORIGINS=https://별도-web.example.com,http://10.20.0.2:1420
```

외부 공개 구성을 확인하고 시작한다.

```bash
docker compose -f compose.yaml -f compose.public.yaml config --quiet
docker compose -f compose.yaml -f compose.public.yaml up -d --build
```

로컬 TTS도 함께 사용한다면 public 핵심 서버를 먼저 시작하고 모델 build를 분리한다.

```bash
docker compose -f compose.yaml -f compose.public.yaml up -d --build
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml build tts-model
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml up -d --no-build
```

같은 서버에 Caddy를 직접 설치한 경우의 최소 개념 예시는 다음과 같다.

```caddyfile
reader.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Ubuntu host nginx를 사용한다면 저장소의 `deploy/host-nginx.example.conf`를 기준으로 기존 server block에
병합한다. 이 예제에는 업로드 청크, 큰 백업, 긴 import 응답을 위한 body limit·timeout·buffering 설정이
포함되어 있다.

```bash
sudo cp deploy/host-nginx.example.conf /etc/nginx/sites-available/moya
sudo nano /etc/nginx/sites-available/moya   # 도메인과 인증서 경로 수정
sudo ln -s /etc/nginx/sites-available/moya /etc/nginx/sites-enabled/moya
sudo nginx -t
sudo systemctl reload nginx
```

이미 같은 이름의 설정이나 symlink가 있다면 새로 만들지 말고 기존 파일을 편집한다. 최소한 일반 요청은
`client_max_body_size 32m`, 백업 경로는 `512m`, `/api/uploads/`와 `/api/backups/`는
`proxy_request_buffering off`가 적용되어야 한다. nginx는 `127.0.0.1:8080`만 프록시하고 Compose의
`WEB_BIND_ADDRESS=127.0.0.1`은 그대로 둔다.

`WEB_BIND_ADDRESS=127.0.0.1`은 그대로 유지한다. 인터넷 공개일 때만 HTTPS용 443과 인증서 발급에 필요한
80을 외부에 열고, WireGuard 전용이면 해당 포트를 VPN interface로 제한한다. 어느 경우에도 8080, 9001,
PostgreSQL, Redis, MinIO API, TTS 포트는 직접 공개하지 않는다.

처음 웹 화면을 연 뒤 모야의 서버 연결/동기화 설정에 `.env`와 같은 Bearer 토큰을 저장한다. 연결 테스트는
공개 `/ready`뿐 아니라 보호된 sync API도 확인한다. 토큰을 저장하면 최초 401로 실패했던 책장도 자동으로
다시 불러온다.

## 6. 평상시 운영 명령

시작할 때 사용한 Compose 파일 조합을 이후 명령에서도 동일하게 사용한다. 아래는 기본 구성 예시다.

```bash
# 상태
docker compose ps

# 최근 전체 로그
docker compose logs --tail=200

# 특정 서비스 로그 계속 보기
docker compose logs -f api
docker compose logs -f worker

# 서비스 재시작
docker compose restart api worker

# 일시 정지와 재시작
docker compose stop
docker compose start

# 컨테이너와 네트워크만 제거하고 데이터 volume은 유지
docker compose down
```

TTS override로 시작했다면 `docker compose` 뒤에 매번 다음 옵션을 붙인다.

```text
-f compose.yaml -f compose.local-tts.yaml
```

### 코드 업데이트

먼저 백업한 후 코드를 받고 이미지를 다시 만든다.

```bash
git pull --ff-only
docker compose config --quiet
docker compose up -d --build --remove-orphans
docker compose ps
```

TTS/public override를 사용 중이라면 업데이트 명령에도 같은 `-f` 조합을 넣는다. API가 시작될 때 필요한
데이터베이스 migration을 실행한다. 업데이트 직후에는 `api`와 `worker` 로그를 확인한다.

## 7. 백업에서 꼭 보존할 것

모야 화면에서 만드는 애플리케이션 백업만으로 Docker 서버 전체를 복원할 수 있는 것은 아니다.
완전한 복구를 위해 다음을 함께 보존한다.

| 대상               | 들어 있는 데이터                          | 중요도                 |
| ------------------ | ----------------------------------------- | ---------------------- |
| PostgreSQL         | 책장, 독서 위치, 메모, 작업 상태          | 필수                   |
| `minio-data`       | 원본 파일, 문서 자산, TTS 오디오          | 필수                   |
| `server-data`      | 업로드 조각, 자동 생성 Provider 암호화 키 | 조건부 필수            |
| `.env`             | 비밀번호, 인증 토큰, 명시적 암호화 키     | 필수, 별도 암호화 보관 |
| `redis-data`       | 대기 작업 AOF                             | 권장                   |
| `local-tts-models` | 다시 받을 수 있는 모델 캐시               | 선택                   |

운영 환경에서는 PostgreSQL dump와 Docker volume snapshot/백업 기능을 함께 사용한다. 일관된 volume
snapshot이 필요하면 먼저 `docker compose stop`으로 쓰기를 멈춘다. 백업 후에는 `docker compose start`로
다시 시작하고 `/ready`를 확인한다.

Provider 키를 `.env`의 `PROVIDER_SECRET_ENCRYPTION_KEY`로 고정했다면 `.env`를 안전하게 보관한다.
자동 생성 방식을 사용했다면 `server-data`를 잃지 않는 것이 특히 중요하다.

다음 명령은 절대 평상시 정지 명령으로 사용하지 않는다.

```bash
docker compose down -v
```

`-v`는 모야의 named volume을 삭제하는 초기화 동작이다. 검증된 백업 없이 실행하면 서버 데이터가
복구되지 않을 수 있다.

## 8. 자주 생기는 문제

### Docker 서버에 연결할 수 없음

`docker version`에서 Server 정보가 나오지 않으면 Docker Desktop/Engine이 꺼져 있는 상태다. 먼저
Docker를 시작한 뒤 다시 실행한다.

### `8080` 또는 `9001` 포트가 이미 사용 중

해당 포트를 사용하는 기존 프로그램이나 이전 Compose 프로젝트를 확인한다. 무작정 모든 컨테이너를
삭제하지 말고 `docker ps`에서 정확한 대상부터 찾는다.

### `api`가 unhealthy

의존 서비스와 API 로그를 순서대로 확인한다.

```bash
docker compose ps
docker compose logs --tail=200 postgres minio redis
docker compose logs --tail=200 api
```

현재 Compose에서는 비어 있는 `DATABASE_URL`과 `S3_*`를 각각 `POSTGRES_*`, `MINIO_ROOT_*`에서 자동으로
만든다. 직접 외부 주소나 S3 자격증명을 넣었다면 오타·URL 인코딩·접근 권한을 확인하고, 그 외에는 손상되거나
누락된 `.env`와 의존 서비스 로그를 확인한다.

### 로컬 TTS가 오랫동안 starting 상태

첫 모델 다운로드 중일 수 있다.

```bash
docker compose -f compose.yaml -f compose.local-tts.yaml logs --tail=200 tts-model
docker compose -f compose.yaml -f compose.local-tts.yaml ps
```

다운로드 오류, 디스크 부족, 메모리 부족을 확인한다. CPU 합성은 준비된 뒤에도 상용 API보다 느릴 수 있다.

### 웹에서 `401 Unauthorized`

Hosted Web에서는 먼저 로그아웃됐거나 30일 세션이 만료되지 않았는지 확인하고 계정으로 다시 로그인한다.
브라우저에 `READER_AUTH_TOKEN`을 반복해서 저장하는 구조가 아니다. 계정 로그인까지 실패하면 API와 PostgreSQL
로그, `DEFAULT_USER_ID` 변경 여부, HTTPS 프록시가 `Set-Cookie`와 `X-Forwarded-Proto`를 보존하는지 확인한다.
운영 자동화나 비상 진단에서만 `.env`의 복구 토큰으로 보호된 API를 직접 확인한다.

```bash
curl -H "Authorization: Bearer $READER_AUTH_TOKEN" https://moya.example.com/api/sync/capabilities
```

`내 계정 만들기`가 나오지 않거나 초기 설정 코드가 거부되면 다음 공개 상태 API를 확인한다. 이 응답에는 계정명,
비밀번호, session token이 포함되지 않는다.

```bash
curl https://moya.example.com/api/auth/status
```

### 웹에서 `403 cors_origin_denied`

같은 도메인의 모야 웹에서 `/api`를 호출하는 기본 구성은 자동 허용된다. 별도 origin의 웹 앱에서 API를
호출한다면 그 브라우저 주소를 scheme과 port까지 정확히 `CORS_ALLOWED_ORIGINS`에 추가하고 컨테이너를 다시
생성한다.

### 파일 가져오기에서 `413` 또는 요청 크기 오류

호스트 nginx 설정에 `client_max_body_size`가 없으면 nginx 기본 1 MiB 제한에서 차단될 수 있다. 최신 웹은
대형 EPUB/PDF의 왕복 횟수를 줄이기 위해 2 MiB resumable 청크를 사용하므로,
`deploy/host-nginx.example.conf`의 일반 요청 32 MiB / 백업 512 MiB 경계를 적용한다. 413 요청은 API에
도달하지 않으므로 `docker compose logs api`가 비어 있을 수 있다.

### 업로드가 100%에서 `Body cannot be empty when content-type is set to 'application/json'`으로 실패

이 메시지는 파일 내용이나 인코딩 오류가 아니라, 구버전 Web 클라이언트가 body 없는 import-complete POST에
JSON Content-Type을 붙이던 문제다. 최신 `main`을 받고 Web image를 반드시 다시 빌드한다. 이미 전송된
resumable upload session은 보존 기간 안이면 같은 파일 재시도 시 이어서 완료할 수 있다.

```bash
git pull --ff-only
docker compose -f compose.yaml -f compose.public.yaml up -d --build --remove-orphans
```

### 파일 가져오기가 중간에 멈춤

먼저 `/ready`의 `components.worker`와 worker 로그를 확인한다.

```bash
curl https://moya.example.com/ready
docker compose logs --tail=300 worker
```

worker heartbeat가 없거나 오래됐으면 `/ready`가 503을 반환한다. 웹도 90초 동안 작업 상태가 전혀 바뀌지
않으면 무한 대기하지 않고 worker 점검 메시지를 표시한다. worker는 오래된 `processing` 작업을 기본 5분 후
다시 큐에 넣으므로, 같은 파일을 즉시 여러 번 올리기 전에 worker와 저장소 상태가 회복되는지 확인한다.

실행 중인 전체 경로를 실제 파일로 점검하려면 저장소 루트에서 다음 smoke를 사용할 수 있다.

```bash
HOSTED_WEB_URL=https://moya.example.com \
HOSTED_API_AUTH_TOKEN="$READER_AUTH_TOKEN" \
pnpm check:hosted:live
```

별도의 검증용 Compose stack을 만들었다가 데이터 volume까지 자동 정리하는 개발/릴리스 게이트는 다음과 같다.
운영 stack 이름과 volume에는 손대지 않는다.

```bash
pnpm check:hosted:e2e -- --public
```

### 디스크 사용량 확인

```bash
docker system df
docker compose images
```

모야 volume인지 확인하지 않은 채 `docker system prune --volumes` 같은 광범위한 정리 명령을 실행하면
안 된다.

## 9. 빠른 명령 모음

기본 서버:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

로컬 TTS 포함:

```bash
docker compose up -d --build
docker compose -f compose.yaml -f compose.local-tts.yaml build tts-model
docker compose -f compose.yaml -f compose.local-tts.yaml up -d --no-build
```

외부 공개:

```bash
docker compose -f compose.yaml -f compose.public.yaml up -d --build
```

외부 공개와 로컬 TTS:

```bash
docker compose -f compose.yaml -f compose.public.yaml up -d --build
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml build tts-model
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml up -d --no-build
```

상세한 데이터 경계, 장애 복구 범위와 운영 검증 항목은
[Docker Compose 기술 운영 런북](docker-compose-deployment.md)을 참고한다.
