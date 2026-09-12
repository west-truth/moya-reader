# 모야 브라우저 Web 앱

이 폴더는 메인 레포 안의 별도 실행·빌드 대상입니다. 독립 레포나 Reader 복사본을 만들지 않습니다.

```text
apps/web/   Web 진입·제품 설정·저장 안내·PWA·정적 배포
src/        기존 앱과 함께 쓰는 Reader·책장·저장소·provider
packages/   기존 앱과 함께 쓰는 텍스트·EPUB·PDF·만화 처리
public/     공통 브랜드와 아이콘
```

메인 레포에서 Reader/파서/저장 코드를 수정하면 다음 Web 빌드에도 같은 코드가 반영됩니다.
Web 전용 정책은 이 폴더에서 runtime의 product 구성으로 주입합니다.
공유 코드가 `apps/web`을 import하거나 Web용 소스 복사본을 생성해서는 안 됩니다.

## 실행

레포 루트에서:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm web:dev
```

개발 주소: http://127.0.0.1:1422/

```powershell
corepack pnpm check:web-local
corepack pnpm web:preview
```

프로덕션 preview: http://127.0.0.1:4174/
배포 파일은 `apps/web/dist/`입니다. 기존 앱의 루트 `dist/`와 분리됩니다.
포트가 다르면 브라우저의 서재도 다릅니다. 기존 서재는 백업 또는 Cloud Vault로 옮깁니다.

## 현재 기능

- 기존 TXT·EPUB·PDF·만화 Reader, 파일 가져오기, 주석, 백업/복원, 시스템 음성.
- 기기 내 IndexedDB 저장, 저장 공간 확인·영구 저장 요청.
- OAuth 설정 시 Dropbox/Google Drive 파일 가져오기 및 Dropbox Cloud Vault.
- 전체 앱 코드·Worker·WASM 사전 캐시, 사용자 선택 업데이트.
- 서버 연결/업로드 차단, 모의 AI 실행 제거, 서버가 필요한 source 미등록.

이 앱은 항상 브라우저 로컬 모드로 시작하며 이전 sync URL이나 server env를 사용하지 않습니다.
AI 분석·고품질 외부 TTS·Suwayomi·텍스트 수집 서버는 이번 Web 실행 범위에 없습니다.
기존 desktop/self-host 진입점과 기능은 유지됩니다.

## OAuth·오프라인·배포

`.env.example`을 이 폴더의 `.env.local`로 복사하고 공개 OAuth 식별자만 설정합니다.
레포 루트의 서버 환경 파일은 Web 설정으로 읽지 않습니다. 최종 HTTPS origin의 OAuth 등록이 필요합니다.
설정이 없으면 클라우드 연결 준비 상태를 안내하고 로컬 파일·백업을 사용할 수 있습니다.

사이트 데이터 삭제 시 서재가 사라질 수 있습니다. 영구 저장 승인도 직접 삭제를 막지는 못합니다.
Cloud Vault 원본 복원은 ‘작품 파일과 표지’ opt-in이 필요하고 원본은 추가 암호화하지 않습니다.
TTS audio는 동기화하지 않으며 대형 만화 전체 복원은 현재 1GiB 한도가 남아 있습니다.
OCR 엔진/언어팩, 일부 OS 음성은 최초 준비 또는 실행에 인터넷이 필요할 수 있습니다.

## GitHub Pages와 데스크톱 앱

웹은 설치 없이 읽는 진입점이며, 메타데이터 수집·네이티브 연동과 설정된 AI/TTS는 데스크톱 앱에서 제공합니다.
앱 정보와 저장/동기화 설정에서 지원 범위와 서재 이동 방법을 안내합니다. 2026-09-11 확인 기준 공개 저장소에
데스크톱 릴리스가 없어 기본 버튼은 ‘데스크톱 출시 확인’입니다. 설치 파일을 공개한 뒤
`VITE_DESKTOP_DOWNLOAD_URL`에 HTTPS 릴리스 또는 다운로드 주소를 설정하면 다운로드 버튼으로 바뀝니다.
외부 AI/TTS는 설치 후에도 제공자 설정이 필요하며, 설치만으로 모든 AI workflow가 완성되는 것은 아닙니다.

프로젝트 Pages 경로로 빌드하고 실제 브라우저 검증을 실행하려면:

```powershell
$env:WEB_BASE_PATH = '/moya-reader/'
corepack pnpm check:web-local
corepack pnpm check:web-pages:browser
corepack pnpm web:preview
```

접속 주소는 `http://127.0.0.1:4174/moya-reader/`입니다. 일반 개발이나 루트 도메인 빌드로 돌아갈 때는
`Remove-Item Env:WEB_BASE_PATH`를 실행하거나 앱의 `.env.local`에서 `/`로 지정합니다.
브라우저 검사는 설치된 Edge를 기본 사용하며, 합성 책만 별도 프로필에서 가져오기·백업·복원합니다.
실제 데스크톱 설치 프로그램, OAuth, 모바일 기기 검증을 대신하지는 않습니다.

공개 배포 절차:

1. 기존 `public:sync` 절차로 `apps/web`과 `.github/workflows/web-pages.yml` 등 이번 변경을 공개 저장소에 반영합니다.
2. 공개 저장소 Settings → Pages → Source를 **GitHub Actions**로 설정합니다.
3. 필요하면 Actions repository variables에 `.env.example`의 공개 OAuth 식별자와 다운로드 URL을 등록합니다.
   Dropbox에는 최종 주소의 전체 경로와 끝 `/`까지 등록합니다. Google에는 최종 origin을 등록합니다.
4. 공개 저장소 main의 Actions → **Web Pages** → **Run workflow**를 실행합니다.

워크플로는 Pages 설정에서 루트/하위 경로를 읽고 검증한 `apps/web/dist`만 배포합니다. push 시 자동 배포하지
않으며 개발용 저장소에서는 실행하지 않습니다. 아직 외부 배포나 GitHub 설정 변경은 수행하지 않았습니다.
Pages의 `_headers` 지원을 전제로 하지 않습니다. 앱은 경로 라우팅 없이 루트 문서와 OAuth query를 사용합니다.
향후 유료 서비스로 확장할 때는 [Pages 사용 제한](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)을 확인합니다.

## 웹에서 데스크톱으로 서재 이동

1. 웹 책장의 **백업** 버튼 또는 **더보기 → 백업 및 복원 → 백업 만들기**로 ZIP을 저장합니다.
2. 같은 버전 또는 더 최신 데스크톱 앱의 로컬 서재에서 **백업 및 복원 → 백업 파일 선택**으로 ZIP을 엽니다.
3. 검사 결과와 기존 책 충돌 처리를 확인한 뒤 **검사한 백업 복원**을 실행합니다.

공통 백업 repository가 원본·본문·읽던 위치·주석을 처리하므로 Web 전용 변환 형식은 없습니다.
화면 크기에 따른 글꼴·레이아웃 등 기기 설정은 복원 대상과 분리됩니다. 복원 후 책과 기록을 확인할 때까지
웹 서재와 백업을 유지하세요. 앱 설치나 다운로드 버튼은 데이터를 자동 전송하지 않습니다.
Cloud Vault 이동은 양쪽 Dropbox 설정과 같은 vault 연결이 필요하며, 원본 이동은 ‘작품 파일과 표지’를 켭니다.

저장소는 origin 단위입니다. 주소·포트가 달라지면 별도 서재이지만, 같은 `사용자.github.io`의 다른 경로는
저장소를 공유할 수 있습니다. 서비스 워커와 앱 캐시는 배포 경로별로 분리하며 IndexedDB 이름은 호환성을 위해 유지합니다.

## 기존 잘못 분리한 폴더

이전 `../moya-web` 독립 복사본은 작업 기준이 아닙니다. 이 폴더로 기능을 통합했고 이후의 변경은
현재 메인 레포 한 곳에서 관리합니다. 이전 복사본은 이 레포의 `.tmp/` 아래 이관 백업으로 보관합니다.

상세 계약: [local-static Web 아키텍처](../../docs/architecture/local-static-web.md).
