<p align="center">
  <img src="assets/branding/moya-wordmark.png" alt="Moya" width="360" />
</p>

<h1 align="center">모야 · Moya</h1>

<p align="center">소설과 만화를 위한 개인 서재</p>

<p align="center">
  <a href="https://github.com/west-truth/moya-reader/actions/workflows/quality.yml"><img src="https://github.com/west-truth/moya-reader/actions/workflows/quality.yml/badge.svg" alt="Quality" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/west-truth/moya-reader" alt="Apache-2.0" /></a>
</p>

<p align="center">
  <a href="https://west-truth.github.io/moya-reader/">웹에서 시작하기</a> ·
  <a href="https://github.com/west-truth/moya-reader/releases">다운로드</a> ·
  <a href="docs/README.md">문서</a> ·
  <a href="https://github.com/west-truth/moya-reader/issues">문제 제보</a>
</p>

모야는 TXT·EPUB·PDF와 이미지 만화를 보관하고 읽는 오픈소스 뷰어입니다.
브라우저에서 바로 사용하거나, 개인 서버에 설치하거나, Windows 앱으로 실행할 수 있습니다.

## 주요 기능

- **서재 관리** — 표지·책장·검색, 연재 작품의 회차 관리와 읽던 위치 저장
- **편안한 읽기** — 스크롤·페이지·양면 보기, 글꼴·테마, 자동 스크롤, 만화 우→좌 읽기
- **독서 기록** — 북마크·하이라이트·메모, 본문 검색과 독서 통계
- **음성 읽기** — 시스템 TTS와 선택형 외부 TTS, AI 화자 분석
- **확장 소스** — 확장 설치, 작품 검색과 회차 다운로드, 표지·작품 정보 보강
- **자료 보관** — 원본 다운로드, 백업과 복원

지원 형식: **TXT, Markdown, EPUB, PDF, ZIP/CBZ, RAR/CBR, 7z/CB7**.
DRM으로 보호된 문서는 지원하지 않습니다.

## 시작하기

### 웹

[모야 웹 열기](https://west-truth.github.io/moya-reader/)에서 파일을 가져오면 바로 읽을 수 있습니다.
서재는 사용하는 브라우저에 저장되며, 오프라인 읽기를 켜거나 홈 화면에 앱으로 설치할 수 있습니다.

AI·외부 TTS·서버 확장은 Windows 앱 또는 self-host에서 사용합니다.
[웹 사용 안내 →](apps/web/README.md)

### Windows

Windows 앱은 서버 설치 없이 **이 PC의 서재**를 만들고, 기존 self-host 서재에도 접속할 수 있습니다.
서재 선택은 **설정 → 동기화**, 다른 기기의 접속 설정은 **설정 → 원격 접속**에서 찾을 수 있습니다.

Windows x64 베타 배포를 준비 중입니다. 설치본이 게시되면
[GitHub Releases](https://github.com/west-truth/moya-reader/releases)에서 받을 수 있습니다.
[소스 빌드 안내 →](docs/platforms/native-build-guide-ko.md)

### Self-host · Docker Compose

Docker Engine과 Compose v2가 필요합니다.

```bash
git clone https://github.com/west-truth/moya-reader.git
cd moya-reader
cp .env.example .env
```

`.env`에서 `POSTGRES_PASSWORD`와 `MINIO_ROOT_PASSWORD`를 설정한 뒤 실행합니다.
기본 구성에서는 `DATABASE_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`를 비워 두면
위 설정에서 자동으로 가져옵니다.

```bash
docker compose up -d --build
```

브라우저에서 **http://127.0.0.1:8080**을 엽니다.
기본 설정은 로컬 접속용입니다. 다른 기기에서 접속하려면 HTTPS와 로그인 설정을 추가하세요.

Nginx Proxy Manager를 사용하는 경우 [compose.npm.yaml](compose.npm.yaml)을 함께 적용합니다.

[설치·외부 접속·업데이트·백업 안내 →](docs/operations/docker-compose-guide-ko.md)

## 사용 안내

1. **가져오기**에서 파일을 선택해 서재에 추가합니다.
2. 책을 열고 글꼴·테마·읽기 방식을 조절합니다.
3. 본문 중앙을 누르면 도구 모음이 열리고, 다시 누르면 닫힙니다.
4. 문장을 선택해 하이라이트나 메모를 남깁니다.

서버 한 곳에 여러 기기로 접속하면 같은 서재를 이용합니다.
별도로 만든 서버와 PC 서재 사이의 자료 이전에는 백업·복원을 사용합니다.

## 개발

Node.js와 pnpm 버전은 [package.json](package.json)의 `engines`, `packageManager`를 기준으로 합니다.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

```bash
corepack pnpm typecheck
corepack pnpm lint
```

- [구조와 개발 문서](docs/README.md)
- [Windows·Android 빌드](docs/platforms/native-build-guide-ko.md)
- [확장 소스 개발](docs/extensions/source-development.md)

버그 제보에는 사용 버전, 운영체제, 재현 순서와 오류 메시지를 포함해 주세요.
비밀번호·토큰·개인 서재 파일은 첨부하지 마세요.

## 참고 사항

- 개인 또는 신뢰할 수 있는 가정 내 사용을 위한 앱으로, 다중 사용자 권한 분리는 제공하지 않습니다.
- 브라우저 저장소를 지우면 웹 로컬 서재도 삭제됩니다. 중요한 자료는 백업해 두세요.
- Docker의 `down -v`는 서재 데이터가 저장된 볼륨을 삭제합니다.
- 확장 소스와 외부 AI/TTS는 제공 서비스와 계정 설정에 따라 이용 가능 여부가 달라집니다.
- Android는 개발 단계이며 공식 설치 패키지는 아직 제공하지 않습니다.

## 라이선스

[Apache License 2.0](LICENSE).
포함된 외부 구성요소의 라이선스는 [Third-party notices](THIRD_PARTY_NOTICES.md)를 참고하세요.
