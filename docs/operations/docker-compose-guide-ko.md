# 모야 Docker Compose 배포 가이드

Status: current
Last verified: 2026-08-04

## 권장 서버 환경

모야의 기준 서버 환경은 **x86-64 Ubuntu + Docker Engine + Docker Compose v2**이다. GitHub 검사는 Ubuntu 24.04에서
실행하며, Node 빌드와 서버 런타임 이미지는 Ubuntu와 같은 glibc 계열인 Debian Bookworm slim을 사용한다. 로컬
TTS 이미지도 Debian 기반이다. 따라서 Windows에서 만든 네이티브 패키지 목록이나 Alpine/musl 패키지가 서버용
라이선스 기준본에 섞이지 않는다.

Ubuntu가 아닌 Linux에서도 같은 Compose 구성을 실행할 수는 있지만, 문서와 CI가 직접 보장하는 기준은 Ubuntu
x86-64이다. Docker를 사용하면 호스트 운영체제와 컨테이너 운영체제는 별개이며, 모야의 Node 컨테이너는 의도적으로
Debian/glibc 계열을 사용한다.

이 문서는 Docker를 처음 사용하는 사람도 모야 서버를 실행할 수 있도록 단계별로 설명한다. 명령은
프로젝트 루트, 즉 `compose.yaml`이 있는 폴더에서 실행한다.

## 먼저 배포 방식을 고른다

| 목적                        | 사용할 구성                               | 권장 대상                                |
| --------------------------- | ----------------------------------------- | ---------------------------------------- |
| 한 컴퓨터에서만 사용        | `compose.yaml`                            | 처음 설치, 개인용 테스트                 |
| 서버와 로컬 한국어 TTS 사용 | `compose.yaml` + `compose.local-tts.yaml` | 외부 TTS 비용 없이 CPU 음성 합성을 쓸 때 |
| 인터넷에서 접속             | `compose.yaml` + `compose.public.yaml`    | 개인 서버, 동일 호스트의 HTTPS 프록시 뒤 |
| 인터넷 접속과 로컬 TTS 사용 | 위 세 파일 모두                           | 개인 서버와 CPU TTS를 함께 운영할 때     |

처음에는 기본 구성으로 정상 실행을 확인한 다음 TTS나 외부 공개를 추가하는 편이 가장 쉽다.

현재 서버 인증은 여러 사용자의 계정을 관리하는 방식이 아니라 하나의 공유 Bearer 토큰을 사용하는
개인 self-host 방식이다. 불특정 다수가 가입하는 공개 서비스로 바로 운영하는 구성은 아니다.

## 어떤 컨테이너가 실행되는가

기본 구성은 다음 서비스를 실행한다.

| 서비스      | 역할                                  | 호스트 공개 여부           |
| ----------- | ------------------------------------- | -------------------------- |
| `web`       | 웹 화면과 `/api` 프록시               | `127.0.0.1:8080`           |
| `api`       | 책장, Reader, 동기화, 백업 API        | 직접 공개하지 않음         |
| `worker`    | 파일 가져오기와 AI/TTS 작업           | 공개하지 않음              |
| `postgres`  | 책장과 독서 데이터의 기준 저장소      | 공개하지 않음              |
| `redis`     | 작업 큐                               | 공개하지 않음              |
| `minio`     | 원본 파일, 문서 자산, TTS 오디오 저장 | Console만 `127.0.0.1:9001` |
| `tts-model` | 선택형 로컬 한국어 TTS                | Compose 내부에서만 사용    |

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

### 개인 컴퓨터에서 먼저 시험할 때

처음 로컬 실행만 확인하려면 기본값으로 시작할 수 있다. 그래도 장기간 사용할 서버라면 아래 자격증명은
반드시 바꾸는 것이 좋다.

```dotenv
POSTGRES_PASSWORD=충분히긴영문숫자비밀번호
DATABASE_URL=postgres://noveldesk:충분히긴영문숫자비밀번호@postgres:5432/noveldesk

MINIO_ROOT_USER=noveldesk-storage
MINIO_ROOT_PASSWORD=충분히긴영문숫자비밀번호
S3_ACCESS_KEY_ID=noveldesk-storage
S3_SECRET_ACCESS_KEY=충분히긴영문숫자비밀번호
```

`POSTGRES_PASSWORD`는 `DATABASE_URL` 안의 비밀번호와 같아야 한다. MinIO의 사용자/비밀번호도 각각
`S3_ACCESS_KEY_ID`와 `S3_SECRET_ACCESS_KEY`에 같은 값을 넣는다. URL 예약문자 인코딩을 피하려면
PostgreSQL 비밀번호에는 긴 영문과 숫자 조합을 사용하는 것이 간단하다.

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

Windows에서 `curl` 사용이 불편하면 브라우저에서 두 주소를 직접 열어도 된다. `/ready`가 성공하고
`docker compose ps`에서 주요 서비스가 `healthy` 또는 `running`이면 기본 서버가 준비된 것이다.

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

기본 서버를 중지할 필요 없이 다음 명령으로 구성을 적용한다.

```bash
docker compose -f compose.yaml -f compose.local-tts.yaml config --quiet
docker compose -f compose.yaml -f compose.local-tts.yaml up -d --build
docker compose -f compose.yaml -f compose.local-tts.yaml logs -f tts-model
```

첫 실행에서는 모델을 내려받으므로 준비에 몇 분 이상 걸릴 수 있다. 다운로드한 모델은
`local-tts-models` volume에 남아서 다음 시작에 재사용된다.

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

## 5. 인터넷에서 접속하도록 공개하기

기본 구성은 안전을 위해 loopback에만 열린다. 외부 공개 시에는 다음 조건을 모두 만족해야 한다.

1. 도메인의 DNS가 서버를 가리킨다.
2. Caddy, nginx 또는 Traefik이 HTTPS를 종료한다.
3. 긴 `READER_AUTH_TOKEN`을 설정한다.
4. 정확한 공개 HTTPS origin을 `CORS_ALLOWED_ORIGINS`에 설정한다.
5. `compose.public.yaml`을 함께 사용한다.

토큰 생성 예시:

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

`.env`에 결과와 도메인을 입력한다.

```dotenv
READER_AUTH_TOKEN=생성한긴토큰
CORS_ALLOWED_ORIGINS=https://reader.example.com
```

외부 공개 구성을 확인하고 시작한다.

```bash
docker compose -f compose.yaml -f compose.public.yaml config --quiet
docker compose -f compose.yaml -f compose.public.yaml up -d --build
```

로컬 TTS도 함께 사용한다면 다음처럼 세 파일을 모두 적용한다.

```bash
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml up -d --build
```

같은 서버에 Caddy를 직접 설치한 경우의 최소 개념 예시는 다음과 같다.

```caddyfile
reader.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

`WEB_BIND_ADDRESS=127.0.0.1`은 그대로 유지한다. 외부 방화벽에는 HTTPS용 443과 인증서 발급에 필요한
80만 열고, 8080, 9001, PostgreSQL, Redis, MinIO API, TTS 포트는 공개하지 않는다.

처음 웹 화면을 연 뒤 모야의 서버 연결/동기화 설정에 `.env`와 같은 Bearer 토큰을 저장한다. 토큰이
없거나 다르면 API 요청은 `401 Unauthorized`가 된다.

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

자주 발생하는 원인은 `POSTGRES_PASSWORD`와 `DATABASE_URL` 불일치, MinIO와 S3 자격증명 불일치,
손상되거나 누락된 `.env`다.

### 로컬 TTS가 오랫동안 starting 상태

첫 모델 다운로드 중일 수 있다.

```bash
docker compose -f compose.yaml -f compose.local-tts.yaml logs --tail=200 tts-model
docker compose -f compose.yaml -f compose.local-tts.yaml ps
```

다운로드 오류, 디스크 부족, 메모리 부족을 확인한다. CPU 합성은 준비된 뒤에도 상용 API보다 느릴 수 있다.

### 웹에서 `401 Unauthorized`

public override를 사용한다면 모야 서버 연결 설정에 저장한 토큰과 `.env`의 `READER_AUTH_TOKEN`이
같은지 확인한다. 토큰을 URL이나 CORS origin에 넣으면 안 된다.

### 파일 가져오기가 중간에 멈춤

worker 로그를 확인한다.

```bash
docker compose logs --tail=300 worker
```

현재 worker는 오래된 `processing` 가져오기 작업을 기본 5분 후 다시 큐에 넣는다. 같은 파일을 즉시 여러
번 다시 올리기 전에 worker와 저장소 상태가 회복되는지 먼저 확인한다.

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
docker compose -f compose.yaml -f compose.local-tts.yaml up -d --build
```

외부 공개:

```bash
docker compose -f compose.yaml -f compose.public.yaml up -d --build
```

외부 공개와 로컬 TTS:

```bash
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml up -d --build
```

상세한 데이터 경계, 장애 복구 범위와 운영 검증 항목은
[Docker Compose 기술 운영 런북](docker-compose-deployment.md)을 참고한다.
