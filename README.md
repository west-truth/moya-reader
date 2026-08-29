<p align="center">
  <img src="assets/branding/moya-wordmark.png" alt="MOYA" width="420" />
</p>

<h1 align="center">모야 — 텍스트 및 만화 뷰어</h1>

<p align="center">
  개인 서재를 위한 self-hosted TXT·EPUB·PDF·만화 뷰어
</p>

<p align="center">
  <a href="https://github.com/west-truth/moya-reader/actions/workflows/quality.yml"><img src="https://github.com/west-truth/moya-reader/actions/workflows/quality.yml/badge.svg" alt="Quality checks" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/west-truth/moya-reader?color=5b68d6" alt="Apache-2.0 license" /></a>
  <img src="https://img.shields.io/badge/self--hosted-Docker_Compose-2456a4?logo=docker&logoColor=white" alt="Docker Compose" />
  <img src="https://img.shields.io/badge/apps-PWA_%C2%B7_Windows_%C2%B7_Android-7b61d1" alt="PWA, Windows and Android" />
</p>

<p align="center">
  <a href="#무엇을-할-수-있나요">기능</a> ·
  <a href="#지원-형식">지원 형식</a> ·
  <a href="#가장-빠른-설치-ubuntu--docker-compose">빠른 설치</a> ·
  <a href="#windows-데스크톱-앱">Windows</a> ·
  <a href="#android-앱">Android</a> ·
  <a href="#라이선스">라이선스</a>
</p>

모야(Moya)는 TXT·EPUB·PDF와 이미지 만화를 한곳에서 보관하고 읽는 개인용 뷰어입니다. 책장, 읽던 위치,
검색, 북마크, 하이라이트, 메모, 통계와 TTS를 지원하며 Docker Compose를 이용해 개인 서버에 설치할 수 있습니다.

> **저장소 공개 범위**
>
> 이 저장소에는 React 웹 앱, 개인 서버, Tauri 데스크톱과 Android 프로젝트를 포함한 **모야 전체 제품
> 소스**가 들어 있습니다. 현재 바로 배포할 수 있는 권장 경로는 Docker 기반 웹 서버입니다. 데스크톱과
> Android는 소스에서 개발자 빌드할 수 있지만, 서명된 공식 installer·APK/AAB는 아직 제공하지 않습니다.

모야는 공개 SaaS가 아니라 한 사람 또는 신뢰할 수 있는 가정 내 사용을 목표로 합니다. 다중 사용자 계정,
권한 관리, 사용량 제한과 테넌트 격리는 제공하지 않습니다.

## 무엇을 할 수 있나요?

- 표지, 컬렉션, 최근 읽은 책과 진행률을 함께 보여 주는 책장
- TXT·Markdown·DRM 없는 EPUB 2/3 읽기
- PDF와 ZIP/CBZ·RAR/CBR·7z/CB7 이미지 만화 읽기
- 본문 검색, 목차, 북마크, 하이라이트, 메모와 독서 통계
- PDF 원문 텍스트와 OCR 보조, 검색·선택·주석·TTS
- 연속 스크롤, 페이지 보기, 양면 보기와 우→좌 만화 진행
- 시스템 음성, 선택형 서버 TTS, 캐시와 전역 미니 플레이어
- 원본 파일 다운로드, 백업·복원, Dropbox Cloud Vault 기반 기기 간 동기화
- 연결된 Dropbox, Google Drive 선택 파일과 Suwayomi/Mihon source를 탐색하는 Source Hub
- 연재 작품 단위 회차 누적, 로컬 회차 추가와 압축 파일 안의 TXT·EPUB 묶음 가져오기
- 선택형 self-host 수집기를 통한 웹소설 표지·작품 정보 자동 보강
- 켜고 끌 수 있는 bundled 신뢰 익스텐션과 선택형 AI 화자 분석·등장인물별 음성 설정

브라우저 화면은 외부 AI/TTS 서비스에 직접 요청하지 않습니다. 외부 provider를 사용할 때는 서버 worker 또는
네이티브 보안 adapter를 거칩니다.

## 지원 형식

| 형식              | 보기 방식        | 주요 지원                                     |
| ----------------- | ---------------- | --------------------------------------------- |
| TXT / Markdown    | 가변형 Reader    | 화 구분, 검색, 주석, 통계, TTS                |
| DRM 없는 EPUB 2/3 | 가변형 Reader    | 목차, 표지·이미지, ruby, 언어 span, 각주, TTS |
| PDF               | 고정 문서 Viewer | 연속 보기, 확대, 텍스트/OCR, 검색, 주석, TTS  |
| ZIP / CBZ         | 만화 Viewer      | 자연순 정렬, 표지, 단면·양면, 좌→우·우→좌     |
| RAR / CBR         | 만화 Viewer      | 단일 볼륨 RAR4/RAR5 이미지 archive            |
| 7z / CB7          | 만화 Viewer      | 단일 볼륨 이미지 archive                      |

DRM이 적용된 EPUB/PDF는 지원하지 않습니다. 가져온 원본은 변환하거나 다시 압축하지 않고 그대로 보관합니다.

## 플랫폼별 현재 상태

| 플랫폼             | 현재 상태                                             | 설치 가능 여부                                |
| ------------------ | ----------------------------------------------------- | --------------------------------------------- |
| 웹·개인 서버       | 공개 소스, Ubuntu CI와 Docker 이미지 빌드 통과, PWA   | **현재 권장 경로**, Chrome에서 앱 설치 가능   |
| Windows 데스크톱   | Tauri 소스 공개, NSIS release build와 실행 smoke 완료 | 소스 빌드 가능, 공식 installer 미제공         |
| Android            | Gradle/Tauri 소스 공개, ARM64/x86_64 emulator alpha   | debug 개발자 빌드 가능, signed APK/AAB 미제공 |
| 브라우저 로컬 개발 | IndexedDB 기반 Reader와 system TTS                    | 개발 서버로 실행 가능                         |

저장소에는 제품 소스와 재현 가능한 개발 검사를 포함합니다. `target/`, Gradle build 출력, APK/AAB, installer,
keystore, 실제 provider credential, 개인 소설 corpus와 내부 리뷰 자료는 포함하지 않습니다.

## 가장 빠른 설치: Ubuntu + Docker Compose

### 1. 준비 사항

권장 서버 환경은 다음과 같습니다.

- x86-64 Ubuntu 22.04 또는 24.04
- Docker Engine과 Docker Compose v2
- Git
- 메모리 8GB 이상
- 로컬 한국어 TTS까지 사용할 경우 메모리 12~16GB 권장
- 책과 TTS cache를 저장할 충분한 디스크 공간

Docker가 준비됐는지 확인합니다.

```bash
docker version
docker compose version
```

`docker version`에서 Server 정보가 나오지 않으면 Docker Engine을 먼저 시작해야 합니다.

### 2. 저장소 받기

```bash
git clone https://github.com/west-truth/moya-reader.git
cd moya-reader
cp .env.example .env
```

Windows PowerShell에서 서버 구성을 시험할 때는 다음 명령을 사용합니다.

```powershell
git clone https://github.com/west-truth/moya-reader.git
Set-Location moya-reader
Copy-Item .env.example .env
```

### 3. 비밀번호 설정

`.env`의 `COMPOSE_PROJECT_NAME=moya-reader`는 그대로 유지하십시오. 이 이름이 PostgreSQL·MinIO 등의 volume
이름을 결정하므로, 나중에 clone 폴더명이나 `-p` 옵션이 바뀌어도 같은 값을 써야 기존 데이터를 찾습니다.

개인 PC에서 잠깐 시험하는 기본 구성은 개발 fallback으로 시작할 수 있지만, 계속 사용할 서버나 public
override에서는 첫 기동 전에 아래 세 저장소 자격증명을 반드시 정해야 합니다.

```dotenv
POSTGRES_PASSWORD=충분히긴영문숫자비밀번호
DATABASE_URL=

MINIO_ROOT_USER=noveldesk-storage
MINIO_ROOT_PASSWORD=다른충분히긴영문숫자비밀번호
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
```

빈 `DATABASE_URL`은 `POSTGRES_*`에서, 빈 `S3_*`는 `MINIO_ROOT_*`에서 자동으로 파생되므로 같은 비밀번호를
중복 입력하다 어긋날 일이 없습니다. 외부 PostgreSQL/S3를 사용할 때만 직접 채우십시오. `.env`는 Git에
올리지 마십시오.

Dropbox/Google 외부 소스를 사용할 때는 `.env.example`의 `MOYA_DROPBOX_*` 또는 `MOYA_GOOGLE_DRIVE_*` 공개
식별자를 채웁니다. 이 값은 Docker Web 컨테이너가 시작될 때 `/runtime-config.js`로 주입되므로 이미지 rebuild
없이 컨테이너 재생성만으로 바꿀 수 있습니다. app/client secret, Bearer token과 AI/TTS provider key는
`MOYA_*` 공개 설정에 넣으면 안 됩니다.

이미 PostgreSQL volume에 데이터가 있다면 `.env`의 비밀번호만 바꾸면 안 됩니다. 먼저 컨테이너 안의
`psql`에서 해당 role 비밀번호를 바꾸고, 그 다음 `.env`를 같은 값으로 맞춰야 합니다. 데이터가 있는 서버에서
비밀번호 문제를 해결하려고 `docker compose down -v`를 사용하면 안 됩니다.

### 4. 실행

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

브라우저에서 다음 주소를 엽니다.

```text
http://127.0.0.1:8080
```

다른 PC에 설치했다면 기본 설정은 서버 자신의 `127.0.0.1`에만 열립니다. 외부 접속 방법은 아래
[WireGuard·LAN·인터넷에서 접속하기](#wireguardlan인터넷에서-접속하기)를 참고하십시오.

상태 확인:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/ready
docker compose logs --tail=100 api worker
```

`/health`는 API와 데이터베이스의 기본 생존 상태를, `/ready`는 Redis queue·MinIO·worker heartbeat까지 함께
확인합니다. 파일 가져오기를 시작하기 전에는 `/ready`가 `ok: true`인지 확인하십시오.

### 5. 처음 사용하기

1. 화면의 **가져오기**를 눌러 TXT, EPUB, PDF 또는 만화 archive를 선택합니다.
2. 가져오기 미리보기에서 제목, 형식과 파일이 맞는지 확인한 뒤 책장에 추가합니다.
3. 책장에서 표지나 제목을 선택해 읽기를 시작합니다.
4. TXT·EPUB은 목차, 본문 검색, 글꼴·간격, 자동 페이지/스크롤 전환과 TTS를 사용할 수 있습니다.
5. PDF·만화는 페이지 이동, 연속 보기, 확대/축소, 양면 보기와 우→좌 진행을 설정할 수 있습니다.
6. 북마크·하이라이트·메모와 읽던 위치는 자동 저장됩니다.
7. 책 정보 화면의 **원본 다운로드**로 서버에 보관된 원본 파일을 다시 받을 수 있습니다.

AI 분석과 외부 TTS는 필수가 아닙니다. 처음에는 기본 Reader와 시스템 음성만 사용하고, 필요할 때 설정에서
provider를 연결하는 편이 간단합니다.

### Chrome에서 앱처럼 설치하기

HTTPS 주소로 접속하면 Windows/Linux/macOS Chrome과 Android Chrome에서 모야를 PWA로 설치할 수 있습니다.

- PC: 주소창 오른쪽의 **설치** 아이콘 또는 Chrome 메뉴의 **전송, 저장, 공유 → 페이지를 앱으로 설치**를
  선택합니다.
- Android: Chrome 메뉴의 **홈 화면에 추가** 또는 **앱 설치**를 선택합니다.

설치 항목이 바로 나타나지 않으면 페이지를 한 번 새로 고치고 잠시 기다리십시오. `http://127.0.0.1`이 아닌
WireGuard/LAN 도메인으로 접속할 때는 반드시 HTTPS reverse proxy가 필요합니다. PWA는 독립 창과 홈 화면
아이콘을 제공하지만 Hosted 책 본문 전체를 오프라인으로 복제하지는 않습니다.

Reader에서는 본문 중앙을 한 번 누르면 상·하단 조작 막대가 숨거나 다시 나타납니다. 조작 막대는 입력이
없을 때도 자동으로 사라지며, 계속 표시하려면 읽기 설정의 화면 UI 고정을 켜십시오. 전체 화면은 하단
더보기 메뉴에서 선택할 수 있습니다.

읽기 방식의 기본값인 **자동**에서는 휠·세로 스와이프는 연속 스크롤로, 방향키·PageUp/PageDown과 화면
이동 버튼은 문장이 잘리지 않는 페이지로 자연스럽게 전환됩니다. 특정 방식만 사용하려면 읽기 설정의
모드 잠금을 선택하십시오. 연속 스크롤에서 화 끝에 도달하면 남은 관성으로 바로 넘어가지 않고, 잠시 멈춘
뒤 한 번 더 아래로 스크롤하거나 위로 밀 때 본문이 살짝 따라오며 다음 화로 이동합니다.

### 6. 중지와 재시작

```bash
docker compose stop
docker compose start
```

구성을 다시 만들려면 다음 명령을 사용합니다.

```bash
docker compose down
docker compose up -d
```

> `docker compose down -v`는 사용하지 마십시오. `-v`는 PostgreSQL, MinIO와 다른 named volume까지 삭제하여
> 책장과 서버 데이터가 사라질 수 있습니다.

## 업데이트

업데이트 전에는 백업을 준비한 뒤, 처음 실행할 때 사용한 Compose 파일 조합을 그대로 사용합니다.

```bash
git pull --ff-only
docker compose config --quiet
docker compose up -d --build --remove-orphans
docker compose ps
docker compose logs --tail=100 api worker
```

장기간 운영하는 서버는 `main`을 자동 추적하기보다 확인된 release tag 또는 commit을 고정하는 편이 안전합니다.
데이터베이스 migration은 API가 시작할 때 실행됩니다.

## 백업

앱에서 만드는 백업 파일만으로 Docker 서버 전체를 복구할 수 있는 것은 아닙니다. 다음 항목을 함께 보관하십시오.

| 대상                         | 들어 있는 데이터                          |
| ---------------------------- | ----------------------------------------- |
| PostgreSQL / `postgres-data` | 책장, 읽던 위치, 주석, 동기화와 작업 상태 |
| `minio-data`                 | 원본 파일, 문서 asset과 서버 TTS audio    |
| `server-data`                | 업로드 상태와 provider secret 암호화 key  |
| `.env`                       | 비밀번호, bearer token과 endpoint 설정    |
| `redis-data`                 | 대기 중인 worker 작업                     |
| `local-tts-models`           | 다시 받을 수 있는 로컬 TTS model cache    |

백업·복구와 장애 확인 절차는 [Docker Compose 한국어 가이드](docs/operations/docker-compose-guide-ko.md)에 더 자세히
정리되어 있습니다.

## WireGuard·LAN·인터넷에서 접속하기

기본 Compose는 안전을 위해 웹 UI와 MinIO Console을 `127.0.0.1`에만 엽니다. WireGuard, LAN 또는 인터넷의
다른 기기에서 접속하려면 HTTPS reverse proxy와 public override를 사용합니다. 첫 브라우저에서만 긴
`READER_AUTH_TOKEN`을 초기 설정 코드로 입력해 소유자 계정을 만들고, 이후 기기는 아이디·비밀번호로 로그인합니다.

먼저 긴 token을 만듭니다.

```bash
openssl rand -hex 32
```

`.env`에 token과 저장소 자격증명을 설정합니다. public override는 하나라도 비어 있으면 컨테이너를 만들기
전에 중단됩니다.

```dotenv
READER_AUTH_TOKEN=위에서-만든-긴-token
POSTGRES_PASSWORD=충분히긴영문숫자비밀번호
MINIO_ROOT_USER=noveldesk-storage
MINIO_ROOT_PASSWORD=다른충분히긴영문숫자비밀번호
```

모야 웹과 `/api`가 같은 nginx 주소에서 제공되면 same-origin이므로 CORS 설정은 필요 없습니다. 별도로 호스팅한
웹 앱이 API를 직접 호출할 때만 `CORS_ALLOWED_ORIGINS=https://별도-web.example.com`처럼 정확한 origin을
추가합니다.

외부 공개용 override를 함께 실행합니다.

```bash
docker compose -f compose.yaml -f compose.public.yaml config --quiet
docker compose -f compose.yaml -f compose.public.yaml up -d --build
```

Caddy 예시:

```caddyfile
reader.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Ubuntu nginx를 사용한다면 [`deploy/host-nginx.example.conf`](deploy/host-nginx.example.conf)의 도메인과
인증서 경로를 바꿔 사용하십시오. 이 예제에는 업로드/백업 body limit, 긴 작업 timeout과 request buffering
설정이 포함돼 있습니다. WireGuard 전용이면 nginx의 443 listen을 WireGuard 주소로 제한하거나 방화벽에서
`wg0`만 허용하면 됩니다.

reverse proxy가 같은 서버에서 실행된다면 `WEB_BIND_ADDRESS=127.0.0.1`을 유지하십시오. PostgreSQL, Redis,
MinIO API, TTS 서비스 포트를 직접 열면 안 됩니다. 첫 접속에서는 `READER_AUTH_TOKEN`을 초기 설정 코드로
사용해 소유자 계정을 만들고, 이후에는 30일 HttpOnly 세션으로 자동 로그인됩니다. 토큰은 자동화와 비상
복구용으로만 보관하며 각 브라우저에 반복 저장하지 않습니다.

### 선택 기능: 웹소설 표지·작품 정보

`설정 → 익스텐션 → 웹소설 표지·작품 정보`를 self-host Web에서도 사용하려면 수집기 override를 추가합니다.

```bash
docker compose -f compose.yaml -f compose.metadata-collector.yaml up -d --build
```

외부 접속 구성에서는 `compose.public.yaml` 뒤에 같은 override를 추가합니다. 수집기는 호스트 포트를 열지 않고
기존 Moya `/api`를 통해서만 접근합니다. 19세 인증 검색이 필요할 때만 Chromium이 포함된
`compose.metadata-collector-auth.yaml`을 마지막에 추가하십시오. 기본 Reader·동기화·공개 메타데이터 검색은
인증용 override 없이 동작합니다. 자세한 설정과 보안 경계는
[Docker Compose 한국어 가이드](docs/operations/docker-compose-guide-ko.md)를 참고하십시오.

### 선택 기능: Suwayomi/Mihon source

사용자 소유 Suwayomi Server에 설치한 Mihon 호환 source를 모야의 `설정 → 소스`와 Source Hub에서 탐색할 수
있습니다. Moya Web과 Suwayomi를 같은 Nginx Proxy Manager Docker network에 붙이는 선택형 profile은 다음과
같이 시작합니다.

```bash
docker network create npm_proxy # 같은 이름의 network가 이미 있으면 생략
docker compose -f compose.yaml -f compose.public.yaml -f compose.suwayomi.yaml config --quiet
docker compose -f compose.yaml -f compose.public.yaml -f compose.suwayomi.yaml up -d --build
```

실행 전 `.env`에 `SUWAYOMI_AUTH_USERNAME`, `SUWAYOMI_AUTH_PASSWORD`와 외부 HTTPS origin인
`MOYA_SUWAYOMI_DEFAULT_URL`을 설정해야 합니다. Suwayomi port는 host에 직접 publish되지 않으며 NPM은 기본
alias `moya-suwayomi:4567`로 연결합니다. 데이터와 설치 source는 `suwayomi-data` volume에 남으므로 일반
업데이트에 `docker compose down -v`를 사용하면 안 됩니다. 전체 NPM/WireGuard·OAuth 설정은
[개인 배포 예제](docs/operations/nginx-proxy-manager-wireguard.md)를 따르십시오.

## 선택 기능: 로컬 한국어 TTS

CPU 기반 MeloTTS 한국어 서비스를 Compose 내부에 추가할 수 있습니다.

```bash
docker compose -f compose.yaml -f compose.local-tts.yaml config --quiet
docker compose up -d --build
docker compose -f compose.yaml -f compose.local-tts.yaml build tts-model
docker compose -f compose.yaml -f compose.local-tts.yaml up -d --no-build
docker compose -f compose.yaml -f compose.local-tts.yaml logs -f tts-model
```

첫 실행에서는 model을 다운로드하므로 몇 분 이상 걸릴 수 있습니다. model은 `local-tts-models` volume에
cache되며 TTS 서비스 포트는 외부에 공개되지 않습니다. 모델 build 또는 health check가 실패해도 첫 명령으로
시작한 책장·Reader·가져오기는 계속 동작하고, 모델이 준비되기 전 TTS 요청만 실패합니다.

외부 접속과 로컬 TTS를 함께 사용할 때:

```bash
docker compose -f compose.yaml -f compose.public.yaml up -d --build
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml build tts-model
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml up -d --no-build
```

이 override는 MeloTTS 한국어 CPU 구성을 위한 것입니다. 다른 엔진을 사용하려면 `/voices`와 `/synthesize`
계약을 구현한 별도 서비스를 연결해야 합니다.

## Windows 데스크톱 앱

Windows 앱은 같은 React Reader를 Tauri v2 shell에 넣은 구조입니다. 로컬 파일 접근, OS secure store,
네이티브 provider/TTS 경계가 구현되어 있고 optimized release 실행 파일과 NSIS installer build·실행 smoke를
통과했습니다.

`src-tauri/` 소스는 이 저장소에 포함되어 있습니다. 개발자 build 기준은 다음과 같습니다.

- Windows 10/11과 WebView2
- Node.js 22, pnpm 11
- Rust stable MSVC toolchain
- Visual Studio C++ Build Tools
- `pnpm install` 후 `pnpm tauri:dev` 또는 `pnpm tauri:build`
- NSIS 결과물: `src-tauri/target/release/bundle/nsis/`

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm check:desktop
pnpm tauri:dev

# 로컬 NSIS installer 생성
pnpm tauri:build
```

빌드된 installer와 `src-tauri/target/`은 Git에 포함되지 않습니다. 공식 서명 installer가 GitHub Releases에
올라오기 전까지 일반 사용자는 웹 서버 설치를 권장합니다.

정식 installer를 제공하게 되면 [GitHub Releases](https://github.com/west-truth/moya-reader/releases)를 설치 기준
경로로 사용합니다.

## Android 앱

Android 앱도 별도 UI를 새로 만든 것이 아니라 같은 React Reader를 Tauri Android WebView에 넣고 Android 전용
파일 선택, back/lifecycle, Keystore, system TTS와 Media Session adapter를 연결한 구조입니다.

현재 Android 소스는 다음 단계까지 도달했습니다.

- ARM64와 x86_64 production-asset debug APK build
- Android 15 Pixel 5 emulator cold launch
- 모바일 safe area와 책장 표시
- Storage Access Framework picker 진입
- picker → import sheet → Library 뒤로가기 흐름
- Android Keystore credential 경계와 system/server/local TTS adapter

하지만 물리 ARM64 기기에서의 실제 파일 import·재실행 지속성, signed APK/AAB, 영구 package identifier,
release signing과 업데이트 검증은 아직 끝나지 않았습니다. 따라서 현재 상태는 **emulator alpha**이며 일반
사용자에게 debug APK 설치를 권장하지 않습니다.

Android Gradle project는 `src-tauri/gen/android/`에 포함되어 있습니다. 개발자 debug build에는 JDK 21,
Android SDK 36, Android NDK와 Rust Android target이 필요합니다.

```bash
corepack enable
pnpm install --frozen-lockfile
rustup target add aarch64-linux-android x86_64-linux-android

# 환경 확인
pnpm check:mobile-readiness

# clean clone에서 Tauri가 사용하는 동적 Gradle 파일 생성
pnpm tauri:android:init

# ARM64 실기기용 또는 x86_64 emulator용 debug package
pnpm tauri:android:build:arm64-debug
pnpm tauri:android:build:x86_64-debug
```

`JAVA_HOME`, `ANDROID_HOME` 또는 `ANDROID_SDK_ROOT`가 설정되어 있어야 합니다. 필요하면 `NDK_HOME`도 지정합니다.
생성된 APK와 Gradle build 출력은 Git에서 제외됩니다. 현재 identifier `com.local.noveldeskreader`는 호환성과
개발을 위한 임시 식별자이므로 첫 signed release 전에 확정해야 합니다. 자세한 준비 과정은
[네이티브 빌드 가이드](docs/platforms/native-build-guide-ko.md)를 참고하십시오.

## 개발용 웹 실행

서버 없이 브라우저의 IndexedDB에 책을 보관하는 로컬 Reader를 개발 모드로 실행할 수 있습니다.

준비물:

- Node.js 22
- pnpm 11

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

브라우저에서 `http://127.0.0.1:1420`을 엽니다. 이 모드는 개발용이며 외부 AI/TTS key를 브라우저에 직접
저장하거나 호출하지 않습니다.

주요 검사 명령:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check:server:production
pnpm check:web-server       # 웹·서버 전체 소스 검사
pnpm check:desktop          # Web build + Tauri Rust compile
pnpm check:mobile-readiness # Android source/toolchain readiness
pnpm check                  # 웹·서버와 Rust 전체 검사
```

서버와 라이선스 인벤토리의 기준 환경은 Linux x64 glibc입니다. 인벤토리 생성은 Ubuntu 또는 WSL2 Ubuntu에서
`pnpm licenses:generate`로 수행합니다. Windows에서는 Linux 기준본을 덮어쓰지 않고 플랫폼 중립 의존성을
검증합니다.

### 브랜드 자산 교체

[브랜드 자산 가이드](assets/branding/README.md)의 워드마크와 앱 아이콘 PNG를 같은 파일명으로 교체한 뒤
다음 명령을 실행하면 Web/PWA, desktop과 Android 파생 아이콘이 함께 갱신됩니다.

```bash
pnpm brand:generate
```

## 문제가 생겼을 때

서비스 상태와 최근 log를 먼저 확인합니다.

```bash
docker compose ps
docker compose logs --tail=200 web api worker postgres redis minio
curl http://127.0.0.1:8080/ready
```

자주 확인할 항목:

- API가 시작되지 않음: 외부 DB URL을 직접 설정했다면 `DATABASE_URL`과 PostgreSQL 자격증명 확인
- 파일 저장 실패: 외부 S3 값을 직접 설정했다면 `S3_*` endpoint와 자격증명 확인
- 연결은 되지만 API가 401: 웹 동기화 패널의 Bearer token과 `.env`의 `READER_AUTH_TOKEN` 비교
- 가져오기가 413: host nginx의 `client_max_body_size`와 `deploy/host-nginx.example.conf` 확인
- 업로드 100% 뒤 `Body cannot be empty...`: 최신 `main`을 pull하고 Web image까지 `--build`로 다시 생성
- 가져오기가 멈춤: `/ready`의 `components.worker`와 `docker compose logs worker` 확인
- 외부 접속 실패: reverse proxy, HTTPS, token, 그리고 cross-origin일 때만 `CORS_ALLOWED_ORIGINS` 확인
- TTS가 준비되지 않음: `docker compose ... logs -f tts-model`로 model 다운로드 상태 확인
- 업데이트 후 이상: `docker compose up -d --build --remove-orphans` 실행 후 API/worker log 확인

더 자세한 문서:

- [처음 설치부터 업데이트·백업까지](docs/operations/docker-compose-guide-ko.md)
- [Docker Compose 기술 운영 문서](docs/operations/docker-compose-deployment.md)
- [WireGuard + Nginx Proxy Manager + Suwayomi 배포](docs/operations/nginx-proxy-manager-wireguard.md)
- [Hosted provider 운영 경계](docs/operations/hosted-provider-admission.md)
- [신뢰 익스텐션 v1 개발 가이드](docs/architecture/trusted-extensions.md)
- [외부 작품 소스 아키텍처](docs/architecture/external-library-sources.md)
- [Windows·Android 네이티브 빌드 가이드](docs/platforms/native-build-guide-ko.md)

## 현재 제한 사항

- 인증은 개인용 소유자 계정 하나만 지원하며 다중 사용자·권한 분리는 제공하지 않습니다.
- DRM이 적용된 EPUB/PDF는 지원하지 않습니다.
- RAR/7z는 단일 볼륨 중심이며 매우 큰 solid archive와 암호화 archive는 추가 검증이 필요합니다.
- OCR 정확도와 처리 시간은 스캔 품질, 언어 data와 서버 자원에 따라 달라집니다.
- CPU MeloTTS는 상용 cloud TTS보다 느릴 수 있습니다.
- 현재 익스텐션은 소스와 함께 검토·빌드되는 trusted 기능입니다. 임의 community package 설치·sandbox는 아직
  제공하지 않습니다.
- Suwayomi/Mihon 연동은 별도 Suwayomi Server가 필요하며 source별 검색·필터 품질은 해당 source 구현에
  영향을 받습니다.
- 인터넷 공개 운영에는 HTTPS, 방화벽, 접근 통제, monitoring과 복구가 검증된 backup이 필요합니다.
- 데스크톱 installer와 signed Android package는 아직 공개 배포되지 않았습니다.

## 라이선스

모야 소스 코드는 [Apache License 2.0](LICENSE)으로 공개됩니다. 사용 중인 라이브러리, WebAssembly 구성요소와
선택형 model은 각자의 라이선스를 따릅니다. 자세한 내용은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)와
`third_party/licenses/`를 확인하십시오.

현재 저장소는 소스 공개와 로컬 소스 build를 위한 단계입니다. 공식 prebuilt container·desktop installer·APK의
재배포 조건은 아직 별도 정리 중이므로 일반 소스 검사를 공식 binary 배포 승인으로 해석하면 안 됩니다.
