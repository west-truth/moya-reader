# 텍스트 소스 설치와 사용

모야는 별도 텍스트 소스 서버가 제공하는 작품·목차를 탐색하고 선택한 UTF-8 TXT 회차를 책장으로 가져옵니다.
소스 서버는 공통 계약을 사용하며 수동 catalog/로컬 TXT와 운영자가 별도 서버 코드에서 주입한 어댑터를 지원합니다.
사이트별 원격 구현은 포함하지 않습니다. 어댑터 설치·자동 업데이트 시스템과 Suwayomi 확장 파일 실행은 지원하지 않습니다.

## 로컬 연결

Node 22 이상에서 `services/text-source-server`로 이동해 실행합니다.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run init
```

생성된 catalog와 `.env`를 [서버 안내](../../services/text-source-server/README.md)에 따라 설정합니다.
직접 브라우저 연결은 `MOYA_ORIGIN`에 모야의 정확한 origin을 지정합니다. `SERVER_KEY`는 소스 서버 접속 키이며
LLM API 키가 아닙니다. 키와 운영 원문은 저장소에 올리지 않습니다.

```sh
npm run check
npm start
```

모야의 `설정 → 소스 → 텍스트 소스 서버`에서 주소(기본 `http://127.0.0.1:9970`)와 `SERVER_KEY`를 입력합니다.
원격 목록·검색·목차와 본문 공급자는 별도 경로입니다. 목록 성공만으로 본문 공급자의 연결 성공을 보장하지 않습니다.
원격 어댑터와 본문 공급자 설정은 [어댑터 계약](../../services/text-source-server/ADAPTERS.md)을 참고합니다.

## Self-host Docker 연결

소스 서버의 초기화·catalog 설정을 먼저 끝내고, 모야 루트 `.env`에 `TEXT_SOURCE_SERVER_KEY`를 설정합니다.
운영 데이터 경로는 `TEXT_SOURCE_DATA_DIR`로 지정하며 기본값은 `./services/text-source-server/data`입니다.
컨테이너의 `node` 사용자가 catalog와 content 디렉터리를 읽을 수 있도록 소유권·ACL을 확인합니다.
별도 원격 어댑터를 서버 코드에 등록했다면 루트 `.env`에도 `SOURCE_ADAPTERS`와 `CONTENT_PROVIDER_*` 설정을 지정합니다.
소스 서버 디렉터리의 `.env`가 루트 Compose에 자동으로 적용되지는 않습니다.

기존 배포 명령에 `-f compose.text-sources.yaml`을 추가합니다. 기본 예시는 다음과 같습니다.

```sh
docker compose -f compose.yaml -f compose.text-sources.yaml up -d --build
```

기존 public/NPM/Suwayomi overlay를 사용했다면 해당 `-f` 옵션도 유지합니다. 이 overlay는 소스 서버의 포트를
호스트에 공개하지 않고 모야 API의 인증된 `/api/integrations/text-sources`를 통해 연결합니다.
브라우저 transport를 사용할 때는 서버 안내에 따라 `TEXT_SOURCE_DOCKERFILE=Dockerfile.browser`,
`SOURCE_HTTP_TRANSPORT=browser`, `TEXT_SOURCE_MEMORY_LIMIT=768m` 이상을 검토합니다.

Hosted upstream은 설치별 단일 catalog/계정 범위입니다. 모야 사용자마다 공급자 계정을 자동으로 나누지 않습니다.
모야 Web/API와 텍스트 소스 서버를 함께 업데이트해야 표지와 가져오기 계약을 사용할 수 있습니다.
서버 업데이트에는 가져오기 revision 충돌 검사용 DB migration 0044와 PostgreSQL 길이 검사를 교정하는
0045가 포함됩니다. 이미 0044를 적용했어도 기존 checksum을 바꾸지 않고 0045로 갱신합니다.

## 회차 사용

- 라이브러리에 추가하면 본문 다운로드 전에도 책장에서 소스 회차 목록을 엽니다. 다운로드 후에도 같은 작품에 연결됩니다.
- 텍스트 소스·Suwayomi·로컬 만화에 검색, 읽음 필터, 처음/최신 순 정렬과 10화 단위 페이지를 제공합니다.
- 최초 전체 목차를 준비한 뒤 저장합니다. 15분 이내 재진입은 재요청하지 않으며 이후에는 저장 목록을 보여 주면서
  백그라운드 확인합니다. 변경이 있으면 `새 목차 적용`으로 반영합니다. 현재 계약의 재검증은 전체 메타데이터 비교입니다.
- 선택한 회차는 처음 화부터 하나씩 저장합니다. 완료된 회차는 나머지 다운로드 중에도 열 수 있으며 현재 읽던 본문이
  바뀌지 않았다면 다음 화 이동 목록도 갱신합니다. 취소·실패 전에 완료한 회차는 유지합니다.
- 표지는 목록/본문과 독립적으로 받습니다. 기존 캐시 작품은 업데이트 후 한 번 새로고침하세요.
- 통합 설정 조회는 60초 간격이고 숨긴 탭에서는 생략합니다. 앱 진입·30초 이상 지난 포커스 복귀에서도 확인합니다.
  로컬 설정 변경 저장은 350ms debounce를 유지하며 독서 위치·다운로드 진행 표시 주기를 늦추지 않습니다.

브라우저를 닫은 뒤 다운로드 자동 재개, 미다운로드 다음 회차 자동 가져오기, 회차별 본문 삭제와 수동 읽음 변경은
현재 제공하지 않습니다. Local 백업을 새 브라우저에 복원할 때 별도 소스 DB의 구독/링크는 포함되지 않으며
Hosted 백업은 통합 설정을 포함합니다. 실제 대규모 self-host 처리량과 네트워크 지연은 운영 환경에서 확인해야 합니다.
