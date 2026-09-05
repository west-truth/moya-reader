# Moya 텍스트 소스 서버

Node 22 이상에서 동작하는 별도 catalog/TXT 서버다. 작품·목차는 소스 어댑터가 제공하고, 회차 본문은 로컬 TXT
또는 주입한 본문 공급자에서 받는다. HTTP core는 공통 계약만 사용하며 공급자나 사이트별 설정을 직접 해석하지
않는다. 기본 설정은 수동 catalog와 `SOURCE_ADAPTERS=[]`이며 원격 소스는 운영자가 명시적으로 선택한다.
목록 요청은 회차 본문을 취득하거나 본문 작업을 생성하지 않는다. 새 소스 작성은 [ADAPTERS.md](ADAPTERS.md)를 따른다.

## 로컬 실행

이 서비스 디렉터리에서 아래 명령으로 고정된 의존성을 설치하고 최초 설정을 만든다. 현재 Node 22 버전을 사용한다.
독립 서비스의 `package-lock.json`을 사용한다.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run init
```

`init`은 `data/catalog.json`, `data/content/`, `.env` 중 없는 항목만 만든다. 접속 키와 서버 identity는 무작위로
생성하며 키는 출력하지 않는다. 기존 파일·작품·키·identity를 덮어쓰지 않는다. 중간에 실패하면 생성·보존·실패한
항목을 안내하고 그대로 남긴다. 충돌과 권한을 확인한 뒤 다시 실행한다. 실패 대상에 빈 파일이 남았다고 안내되면
직접 확인하고 복구하며, 기존 설정을 자동 삭제하지 않는다.

새 catalog는 비어 있고 원격 소스는 선택되어 있지 않다. 아래 예시로 로컬 작품을 등록하거나
[원격 소스 설정](#선택적인-원격-본문과-소스)을 적용한 다음 진단하고 실행한다.

```sh
npm run check
npm start
```

`start`와 `check`는 Node의 `--env-file-if-exists=.env`로 `.env`를 읽는다. PowerShell에서도 별도 export 없이 같은
명령을 쓴다. 이미 지정한 프로세스 환경 변수는 `.env`보다 우선한다. init이 만든 경로는
`CATALOG_FILE=./data/catalog.json`, `SOURCE_ROOT=./data/content`다. 기존 `.env`가 보존되었다면 이 경로도 확인한다.
기본 주소는 `127.0.0.1:9970`이며 `HOST`, `PORT`로 바꿀 수 있다. `SERVER_KEY`는 공백 없는 16자 이상의 비밀값이고
Moya Local의 접속 토큰에 사용한다. `.env`에서 직접 확인하되 로그나 메시지에 붙이지 않는다.

브라우저에서 직접 연결할 때만 `.env`의 `MOYA_ORIGIN`에 Moya의 정확한 origin(예: `https://moya.example`)을 설정한다.
경로와 끝의 `/`는 포함하지 않는다. `Origin`이 없는 인증된 gateway/native 요청도 허용한다. 최초값은 비어 있으므로
직접 브라우저 연결 전에 설정해야 한다.

`check`는 키·포트·CORS 설정, catalog 구조와 source root, 선택한 어댑터의 등록 가능 여부를 검사한다. 본문 공급자가
설정되어 있으면 인증된 `GET /health` 한 번으로 `protocol: 1`, `ready: true`를 확인한다. 요청은 5초·JSON 64 KiB로
제한하고 endpoint·key·공급자 식별자·응답 본문을 출력하지 않는다. 작품 목록·본문·job 생성 요청은 하지 않으며,
로컬 TXT의 존재·본문 UTF-8·실제 가져오기까지 검증하는 명령은 아니다. 실패 시 종료 코드 1과 수정할 설정을 안내하고,
빈 소스 목록·비활성 공급자·미설정 CORS는 안내로 구분한다. 안내만 있는 경우 종료 코드는 0이다.

catalog 예시:

```json
{
  "instanceId": "my-server",
  "dataNamespace": "my-library-v1",
  "sources": [
    {
      "id": "local",
      "name": "내 TXT 소스",
      "works": [
        {
          "id": "work-1",
          "title": "합성 예시 작품",
          "author": "예시 작가",
          "releases": [
            { "id": "chapter-1", "title": "1화", "order": 1, "revision": "v1", "file": "work-1/chapter-1.txt" }
          ]
        }
      ]
    }
  ]
}
```

catalog는 시작 시 한 번 읽는다. 수정 후 서비스를 재시작한다. ID는 `[A-Za-z0-9_-]{1,128}`이며 작품 내 회차 ID,
소스 내 작품 ID, 전체 소스 ID는 중복될 수 없다. `instanceId`, `dataNamespace`는 256자 이하의 영구 식별자다.
다른 데이터 집합이나 계정으로 전환할 때는 namespace도 바꾼다. 제목·순서는 ID를 바꾸지 않는다.

`file`은 `SOURCE_ROOT` 내부의 상대 `.txt` 경로다. 실제 경로를 다시 확인하므로 외부 파일을 가리키는 symlink는
거부한다. catalog의 절대 경로, `..`, 제어 문자도 거부한다. UTF-8 유효성을 검사하지만 BOM, CRLF, 들여쓰기,
앞뒤 공백과 본문을 정규화하지 않는다. `revision`이 있으면 본문을 수정할 때 함께 변경해야 한다.

## HTTP 계약

모든 GET 요청에 `Authorization: Bearer <SERVER_KEY>`가 필요하다. 요청/본문/URL/credential은 로그에 남기지 않는다.
오류는 `{ "error": "safe_code" }`만 반환한다. CORS는 정확히 설정한 origin만 허용하며 credential이 없는 OPTIONS는
GET와 Authorization/Accept preflight에만 사용한다.

인증된 응답은 `X-Moya-Source-Namespace`에 `encodeURIComponent(JSON.stringify([instanceId, dataNamespace, "single"]))`를
보낸다. broker는 health에서 확인한 값과 각 응답을 비교하여 서버 데이터 전환을 감지한다. CORS는 이 헤더와 ETag를
노출하고, Hosted gateway도 그대로 전달해야 한다.

| 경로                                                               | 결과                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `GET /v1/health`                                                   | protocolVersion 1, instanceId, dataNamespace, capability와 byte 한도 |
| `GET /v1/sources`                                                  | `items: [{id,title,available}]`, optional nextCursor                 |
| `GET /v1/sources/{id}/works?query=&cursor=&limit=`                 | 작품 metadata와 nextCursor                                           |
| `GET /v1/sources/{id}/works/{workId}`                              | 작품 metadata와 TXT/UTF-8/single profile                             |
| `GET /v1/sources/{id}/works/{workId}/releases?cursor=&limit=`      | id/title/sourceOrder/optional revision                               |
| `GET /v1/sources/{id}/works/{workId}/releases/{releaseId}/content` | exact UTF-8 `text/plain`, ETag                                       |

목록 기본 50개, 최대 100개이며 cursor는 응답의 값을 그대로 전달한다. 잘못된 숫자·중복·알 수 없는 query는
거부한다. 수동 catalog 검색은 제목/작가를 대상으로 하며 원격 검색은 선택한 어댑터의 계약을 따른다.
수동 catalog에서 같은 순서는 stable ID로 정렬한다. catalog revision이 있을 때
목록 revision과 content ETag는 동일한 opaque 값이다. revision이 없으면 목록은 변경 여부를 단정하지 않으며
본문 요청의 ETag만 실제 bytes hash로 반환한다.

cursor는 숫자로 해석하지 않는 opaque 값이다. 새 static cursor는 소스·작품·query와 목록 ID 구성에 고정된다.
원격 어댑터도 필요한 페이지부터 반환하고 cursor의 검색·작품 범위를 검증한다. 바뀐 페이지의 남은 offset을
안전하게 적용할 수 없으면 다시 조회하도록 오류를 반환한다.

catalog는 최대 4 MiB, TXT 한 회차는 최대 2 MiB다. 본문 요청은 동시에 최대 2개이며 추가 요청은 429를 받는다.
본 서비스의 catalog 용량과 Moya 한 작품의 import 지원 한도는 별개다.

## 선택적인 원격 본문과 소스

본문 공급자와 소스 목록은 별도 설정이다. 다음 기본값은 원격 소스를 활성화하지 않는다.

```dotenv
SOURCE_ADAPTERS=[]
CONTENT_PROVIDER_PROTOCOL=job-v1
CONTENT_PROVIDER_ENDPOINT=
CONTENT_PROVIDER_KEY=
```

protocol 기본값은 `job-v1`이며 endpoint를 지정하지 않으면 본문 공급자는 비활성이다.
`SOURCE_ADAPTERS`는 제공된 어댑터 ID와 설정을 담은 JSON 배열이다. 모듈 경로나 설치 URL이 아니며, 선택하지 않은
소스는 등록하지 않는다. 지원 어댑터의 구체적인 opt-in 예시는 [ADAPTERS.md](ADAPTERS.md#현재-두-구현의-책임)에 있다.
원격 어댑터만 쓸 때도 `data/content/`를 만들고 서버 identity용 catalog를 다음처럼 준비한다.

```json
{ "instanceId": "my-text-server", "dataNamespace": "my-library-v1", "sources": [] }
```

원격 본문이 필요하면 `CONTENT_PROVIDER_PROTOCOL=job-v1`, `CONTENT_PROVIDER_ENDPOINT`,
`CONTENT_PROVIDER_KEY`를 설정한다. endpoint는 해당 프로토콜을 제공하는 API origin이며 query·credential·path
prefix를 받지 않는다. 공급자 key는 catalog나 Moya 브라우저에 넣지 않는다. source adapter 설정과 공급자는
[source-configuration.mjs](src/source-configuration.mjs)의 `createConfiguredSources`에서 조립해 core에 주입한다.

수동 catalog에서도 `file` 대신 운영자가 확인한 HTTPS `contentUrl`을 지정할 수 있다. 두 항목을 동시에 쓰지 않는다.

```json
{ "id": "chapter-2", "title": "2화", "order": 2, "contentUrl": "https://operator-selected-source.example/novel/work/2" }
```

`job-v1` driver는 작업 생성, 상태 조회, manifest 취득과 close를 수행한다. 본문 반환은 `kind: novel`, 동일 job ID와
회차 URL, 문자열 text를 검증한다. 작업 생성은 재시도하지 않고 90초 이내 polling, JSON 4 MiB, 회차 UTF-8 2 MiB,
body 정지 10초를 제한하며 redirect를 거부한다. job ID를 받은 경우 성공·실패·취소 모두 main abort와 분리된
최대 3초 cleanup을 시도한다. 생성 응답을 잃어 ID를 모르면 공급자의 TTL 정리에 의존한다. text 문자열은 추가
trim·공백 압축 없이 UTF-8로 변환한다.

driver는 [content-job-provider.mjs](src/content-job-provider.mjs)에 있고 함수 계약은
[ContentProvider](contracts.d.ts)다. 코드·loopback fixture 검사와 실제 공급자
설치·로그인·사이트 호환·운영 배포는 별도 검증이다. 접근 권한 판단은 공급자와 소스에 남으며 자동 구매나 인증
우회는 추가하지 않는다.

## 선택적인 브라우저 메타데이터 전송

`SOURCE_HTTP_TRANSPORT=http`가 기본이다. 정상 브라우저 연결이 필요한 운영 환경에서는 운영자가
`SOURCE_HTTP_TRANSPORT=browser`를 명시적으로 선택한다. 본문 공급자 설정과는 별개이며 작품 목록·목차의
HTML/JSON GET에만 적용된다. 일반 HTTP 실패를 감지하여 자동으로 브라우저로 전환하지 않는다.

로컬 Windows에서 설치된 Edge를 사용하려면 `.env`에 다음을 설정한다.

```dotenv
SOURCE_HTTP_TRANSPORT=browser
SOURCE_BROWSER_CHANNEL=msedge
```

채널을 비우면 Playwright에 준비된 Chromium을 사용하며, `playwright-core` npm 설치 자체는 브라우저 바이너리를
다운로드하지 않는다. Compose에서는 `TEXT_SOURCE_DOCKERFILE=Dockerfile.browser`,
`SOURCE_HTTP_TRANSPORT=browser`를 선택하고 `SOURCE_BROWSER_CHANNEL`은 비운다. Hosted overlay의 브라우저
실행에는 `TEXT_SOURCE_MEMORY_LIMIT=768m` 이상을 운영 환경에 맞게 지정한다. 두 Compose 파일은 읽기 전용
컨테이너에서 브라우저가 쓸 `/tmp` tmpfs 256 MiB와 `/dev/shm` 256 MiB를 제공한다.

브라우저는 첫 요청에 시작하고 재사용하지만 요청마다 빈 컨텍스트를 만든다. JavaScript·service worker를
비활성화하며 하위 리소스와 redirect는 전송 전에 거부한다. 기본 브라우저 UA·TLS와 인증서 검증을 유지하고,
쿠키 프로필·사용자 로그인·지문 변경 설정은 가져오지 않는다. 문서를 렌더링하지 않고 response stream을
64 KiB씩 읽어 압축 해제 후 1 MiB 상한을 적용한다. 원본을 DOM으로 직렬화하거나 `Response.body()` 전체 읽기로
변환하지 않는다. 동시에 두 요청, 대기 여덟 요청까지 허용하며 그 이상은 `source_busy`로 응답한다.
대기를 포함한 총 제한은 15초, 본문 정지는 최대 10초다. 취소·종료 시 대기 요청과 컨텍스트를 닫는다.

브라우저 검사는 기본 Node 검사에서 설치 환경이 필요하다고 명시하며 건너뛴다. 준비된 브라우저 환경에서
`RUN_SOURCE_BROWSER_TESTS=1`로 `node --test test/browser-source-http.test.mjs`를 실행한다. Windows Edge는
추가로 `SOURCE_BROWSER_CHANNEL=msedge`를 지정한다. 합성 loopback 서버로 bytes·redirect·용량·대기·취소를
검사하며 실제 소스에 요청하지 않는다. 시스템 HTTP 필터가 응답을 수정하는 환경의 byte 동등성 실패는 별도로
기록하고, 이를 통과시키려고 사용자 보안 설정을 변경하지 않는다.

## 컨테이너와 종료

호스트에서 `npm run init`을 실행하고 `.env`와 catalog를 설정한 뒤 `docker compose up --build -d`로 실행한다.
수동 설정은 `.env.example`을 참고한다. image에는 Node와
서버 코드, lockfile로 고정한 production 의존성이 들어간다. `data/`는 읽기 전용 mount이고 port는 host loopback에만 게시한다.
별도 build context는 Dockerfile·package 파일·`src/`와 초기화·진단 스크립트만 허용하며 운영 `data/`와 `.env`를 포함하지 않는다.
초기화 파일은 소유자에게만 읽기·쓰기 권한을 요청하므로 컨테이너의 `node` 사용자도 catalog와 content 디렉터리를
읽을 수 있도록 운영 환경의 소유권·ACL을 확인한다. `.env`의 비밀값은 파일 mount 대신 Compose 환경으로 전달한다.
Moya Hosted gateway와 같은 Docker network에서 연결할 경우 gateway의 단일 upstream을 이 서비스에 지정한다.
임의 URL proxy로 공개하지 않는다. Docker 배포 자체는 이 구현의 Node 테스트로 검증된 것이 아니다.

SIGINT/SIGTERM은 새 요청 수신을 중단하고 진행 중 작업을 취소한다. 알려진 본문 job의 cleanup을 유한하게 기다린다.
`init: true`가 Node에 신호를 전달하며 Compose의 종료 유예는 10초다.

## 검사

```sh
node --test
```

임시 합성 catalog/TXT와 loopback 가짜 본문 공급자로 scope·pagination·인증/CORS·정확한 bytes·경로 탈출·oversize·
abort·body 정지·redirect·job cleanup을 검사한다. 사용자 원문이나 실제 source 응답을 fixture로 저장하지 않는다.
