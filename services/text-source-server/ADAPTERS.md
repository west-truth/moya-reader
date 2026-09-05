# 텍스트 소스 어댑터 작성

## 선택형 표지 조회 (2026-09-05)

- ABI/protocol 1에 선택형 `cover-read` capability와 `getCover({ workId, signal })`를 추가했다.
  기존 네 메서드만 제공하는 어댑터도 그대로 동작한다. 작품 메타데이터의 `hasCover: true`는 표지 유무만 알린다.
- 인증된 `GET /v1/sources/:sourceId/works/:workId/cover`는 `bytes`와 `contentType`으로 받은
  JPEG/PNG/WebP만 반환한다. 한도는 8 MiB이고 SVG/HTML, 임의 URL query는 허용하지 않는다.
- URL·CDN 허용 범위는 신뢰된 어댑터가 결정한다. 해당 소스의 허용 origin만 받고 표지 주소를 공개 메타데이터에 넣지 않는다.
- 표지 요청은 본문 제공자 job과 별개다. 브라우저 HTTP transport도 명시적 이미지 요청의 원본 응답만 수집한다.

이 서버의 어댑터는 작품 검색·상세·목차·본문을 제공하는 **신뢰된 서버 모듈**이다. HTTP 서버는 인증, CORS,
요청 제한과 응답 검증을 맡고, 어댑터는 소스별 탐색·ID·pagination·본문 취득을 맡는다. Moya는 공통 텍스트 소스
프로토콜을 사용하므로 새 소스를 추가할 때 Moya UI에 소스별 분기를 넣지 않는다.

ABI는 `apiVersion: 1`이며 TypeScript 형식은 [contracts.d.ts](contracts.d.ts), 실행 시 검증은
[adapter-contract.mjs](src/adapter-contract.mjs), 등록 경계는 [adapter-registry.mjs](src/adapter-registry.mjs)에 있다.
이 계약은 임의의 사용자 코드 실행을 격리하는 sandbox가 아니다. 다운로드한 모듈의 자동 설치, APK 실행,
사용자 입력 URL에서의 module import와 `eval`은 지원하지 않는다.

## 외부 개발자가 새 소스를 추가하는 현재 방식

작품·회차 중심 모델은 이미지 소스와 같은 방향이지만 HTTP API는 Suwayomi 호환 API가 아닌 별도 텍스트 계약이다.
새 서버 어댑터가 아래 메서드를 구현하면 Moya 화면, 목차 캐시, 회차 정렬·다운로드·Reader 코드는 그대로 사용한다.
서버 조립 코드에서 `createTextSourceServer({ ..., additionalAdapters: [adapter] })`로 주입할 수 있고, 기본 실행 파일에
통합하려면 조립 코드에서 `configuredSourcesFromEnvironment(process.env, { sourceAdapterFactories })`에
신뢰된 ID→factory Map을 전달한다. factory는 `(sourceSettings, contentProvider, fetchImpl) => adapter` 계약이며
자기 설정의 허용 필드를 검증한다. 기본 Map은 비어 있다. 현재 배포 방식은 코드 등록 후 재시작/재빌드다.

따라서 현재 범위는 **범용 계약과 서버 어댑터 구조**다. 사용자용 확장 저장소 추가, 패키지 설치·업데이트,
서명/호환성 검사와 소스별 설정·인증 UI를 갖춘 배포 생태계는 아직 없다. `SOURCE_ADAPTERS`에 임의 URL이나 패키지
이름을 넣는 것만으로 새 소스가 설치되지 않는다. 도메인·HTML 선택자·목차 API·본문 공급자 선택은
각 어댑터/서버 조립에만 있으며 서로 같은 사이트 구조나 본문 공급자를 사용할 필요는 없다.

## 기본 구현의 책임

[Static catalog](src/static-catalog-adapter.mjs)는 시작 시 검증한 운영자 JSON에서 작품·목차와 로컬 검색을 제공한다.
본문은 `SOURCE_ROOT` 내부 TXT 또는 `contentUrl`의 본문 공급자 요청으로 가져온다. catalog의 각 source마다
자동 등록하며 `search`와 `txt-content` capability를 선언한다. 목록 조회는 TXT 파일이나 본문 공급자를 호출하지 않는다.

사이트별 원격 어댑터는 공개 기본 구성에 포함하지 않는다. 운영자가 별도 신뢰된 구현을 주입해야 한다.
`SOURCE_ADAPTERS`는 등록된 factory의 ID와 데이터 설정만 선택하며 임의 module 경로나 설치 URL은 받지 않는다.
환경 변수와 배포 절차는 [서버 README](README.md)와 [운영 안내](../../docs/operations/external-text-sources.md)를 따른다.

## 본문 공급자와 서버 조립

[contracts.d.ts](contracts.d.ts)의 `ContentProvider`는
`(url: string, signal?: AbortSignal) => Promise<Uint8Array>` 함수다. 소스 어댑터가 회차 URL의 허용 origin과 작품
소속을 검증하고, 공급자가 본문 취득·크기 제한·취소·작업 cleanup을 맡는다. HTTP core에는 이 callback과
`additionalAdapters`를 주입하며 core가 프로토콜이나 사이트 ID를 직접 선택하지 않는다.

제공된 `job-v1` driver는 [content-job-provider.mjs](src/content-job-provider.mjs)의
`createContentJobProvider`다. protocol·endpoint·key를 사용하는 구체적인 driver 선택은
`createConfiguredSources({ contentProviderProtocol, contentProviderEndpoint, contentProviderKey,
contentProviderLimits?, sourceAdapters })`가 맡고 `{ contentProvider, additionalAdapters }`를 비동기로 반환한다.
`sourceAdapters`는 JSON 문자열이 아닌 배열이다. 환경 변수에서는 `configuredSourcesFromEnvironment(env)`가
`SOURCE_ADAPTERS`의 JSON을 파싱하고, 미지정 시 빈 배열을 사용한다.

수동 catalog의 원격 회차도 `contentUrl`을 통해 같은 callback을 사용한다. `file`과 `contentUrl`은 동시에
지정하지 않는다. 다른 프로토콜 공급자를 추가할 때는 새 driver와 composition 등록을 구현하면 되며 어댑터의
네 메서드 또는 Moya UI에 공급자 분기를 추가하지 않는다.

## ABI version 1

어댑터 객체의 필수 필드는 `apiVersion`, `id`, `title`과 아래 네 메서드다. `capabilities`를 생략하면
`['txt-content']`로 처리한다. 명시할 때도 `txt-content`가 필요하며 `search`와 `cover-read`를 선택적으로 추가할 수 있다.
중복·알 수 없는 capability와 구현되지 않은 ABI version은 시작 시 거부한다.

| 메서드         | 입력                                  | 결과                                |
| -------------- | ------------------------------------- | ----------------------------------- |
| `listWorks`    | `{ query?, cursor?, limit, signal? }` | `{ items: Work[], nextCursor? }`    |
| `getWork`      | `{ workId, signal? }`                 | `Work`와 `seriesProfile`            |
| `listReleases` | `{ workId, cursor?, limit, signal? }` | `{ items: Release[], nextCursor? }` |
| `getContent`   | `{ workId, releaseId, signal? }`      | `{ bytes: Uint8Array, revision? }`  |

`Work`는 `{ id, title, author?, description?, tags?, hasCover? }`다. `Release`는
`{ id, title, sourceOrder, revision? }`다. `sourceOrder`는 유한한 숫자이며 제목에서 회차 번호를 다시 추론하지
않는다. 작품 상세의 ID는 요청한 `workId`와 같아야 하며, 현재 `seriesProfile`은 다음 값만 지원한다.

```json
{ "kind": "document_series", "format": "txt", "encoding": "utf-8", "chapterSplitMode": "single" }
```

`getContent`는 호출자가 지정한 작품에 회차가 속하는지 확인해야 한다. 다른 작품에 존재하는 `releaseId`를
찾았다는 이유로 본문을 반환하면 안 된다. registry는 ID 형식과 결과 형식을 검사하지만, 소스의 실제 소유 관계는
어댑터만 알 수 있다. 본문 URL은 검증한 ID와 허용 origin으로 구성하고, 원격 metadata의 URL이 접근 범위를
넓히도록 허용하지 않는다.

## ID와 데이터 범위

- source·work·release ID는 `[A-Za-z0-9_-]{1,128}`이다. source ID는 registry 안에서 중복될 수 없고, work ID는
  소스 안에서, release ID는 작품 안에서 안정적으로 유지한다. 제목·표시 순서·일시적인 origin 주소를 ID로 쓰지 않는다.
- `instanceId`와 `dataNamespace`는 서버 catalog에서 읽으며 health와 이후 응답의 namespace header를 구성한다.
  어댑터 추가만으로 기존 작품 ID를 다시 생성하거나 namespace를 임의 변경하지 않는다.
- 같은 ID가 다른 작품·계정·데이터 집합을 가리키게 되는 교체, ID 생성 방식의 비호환 변경, 계정 범위 전환 시에는
  namespace를 바꿔 기존 연결과 분리한다. 같은 논리 소스의 origin 이동이나 제목 수정은 ID 의미가 유지되는 한
  namespace 변경 사유가 아니다.
- ID가 안정적이지 않은 소스는 매번 새 ID를 만드는 방식으로 연결하지 않는다. 안정적인 ID를 결정할 수 있는
  metadata와 scope를 먼저 정의한다. Moya의 책장 연결·회차 갱신·읽음 기록은 이 계약에 의존한다.

## Pagination과 응답 한도

registry가 `limit`의 기본값을 50으로 채우며 1~100의 정수만 허용한다. 검색어는 최대 200자이고, 비어 있지 않은
검색어를 받으려면 `search` capability가 필요하다. URL 경계는 중복·알 수 없는 query와 잘못된 숫자를 거부한다.

cursor는 최대 512자의 불투명 문자열이다. HTTP 서버나 Moya가 숫자로 해석하지 않으며, 어댑터가 source·work·검색
범위와 offset 또는 원격 cursor를 검증한다. 다른 작품·검색의 cursor를 재사용하면 안전한 오류를 반환한다.
페이지의 항목 수는 요청 `limit` 이하여야 하고, ID가 중복되면 안 된다. 빈 페이지나 입력 cursor와 같은 값을
`nextCursor`로 반환하면 공통 경계에서 거부한다. 어댑터는 더 긴 cursor 순환과 원격 페이지 정체도 유한한 요청
횟수로 감지해야 한다.

Static adapter는 source·method·work·검색과 정렬된 ID snapshot으로 cursor 범위를 고정한다. 원격 어댑터는 자체
cursor envelope를 사용할 수 있지만 입력의 원격 URL을 그대로 요청해서는 안 된다. 목록이 바뀌어 기존 offset이
다른 항목을 가리키면 변경 오류로 다시 탐색하도록 한다. 무한 재조회로 해당 offset을 맞추지 않는다.

| 경계          | 한도와 동작                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------- |
| 등록 소스     | registry 최대 100개, 중복 ID 거부                                                            |
| 공개 metadata | 한 응답 JSON의 UTF-8 bytes 최대 1 MiB                                                        |
| 표시 metadata | source·work·release title 및 author 최대 256자, description 8,192자, tags 최대 50개·각 100자 |
| 회차 본문     | 비어 있지 않은 `Uint8Array`, 최대 2 MiB, fatal UTF-8 검사                                    |
| wire revision | ASCII quoted ETag, `W/` 허용, 전체 최대 256자                                                |

공개 응답은 허용 필드만 복사한다. 내부 URL·cookie·credential·HTML 등은 결과 객체에 넣어 전달하지 않는다.
문자 수는 Moya broker와 같은 JavaScript 문자열 길이(UTF-16 code unit) 기준이다. 공통 ABI는 초과한 metadata를
거부한다. 기존 static catalog loader의 title·author 500자, description 10,000자 입력은 유지하되, static adapter는
공개 표시 metadata만 위 한도로 자른다. 잘린 끝의 surrogate pair가 깨지지 않도록 처리하며 원본 catalog,
ID·revision·TXT bytes는 변경하지 않는다. 새 어댑터는 반환 전에 이 공개 한도를 맞춰야 한다.
metadata 크기 검사는 반환 경계의 제한이므로 어댑터는 원격 응답을 읽거나 파싱하기 전에도 크기를 제한해야 한다.
[source-http.mjs](src/source-http.mjs)는 허용 origin, redirect 거부, 실제 수신 bytes와 body 정지 시간을 검사하는
공통 도구다.

본문은 받은 UTF-8 bytes를 보존한다. trim·공백 압축·줄바꿈 또는 BOM 변환을 하지 않으며, 반환 후 bytes를
수정하지 않는다. revision은 목록과 본문이 같은 의미를 사용해야 한다. 이미 HTTP ETag 형식인
`"revision-1"` 또는 `W/"revision-1"`처럼 반환하며 임의 Unicode 문자열·따옴표 없는 값은 거부한다.
목록 단계에서 revision을 모르면 생략한다. content에서도 생략하면 서버가 실제 bytes의 hash ETag를 만든다.
매번 timestamp를 만드는 방식으로 revision을 꾸며내지 않는다.

## 취소·시간 제한·오류

모든 네트워크·파일 작업과 반복문에 전달받은 `signal`을 연결하고, await 전후 및 결과 cache 반영 전에 취소를
확인한다. registry는 호출 전후 취소를 검사하고 HTTP 서버는 어댑터가 signal을 무시해도 늦은 응답을 폐기한다.
이는 어댑터 내부의 작업이나 원격 job까지 강제로 중단한다는 뜻이 아니다. 생성한 resource의 cleanup은 어댑터
책임이며, `job-v1` driver는 알고 있는 job ID를 별도의 최대 3초 cleanup으로 닫는다.

기본 HTTP 경계는 metadata 동시 8개·15초, 본문 동시 2개·95초다. 한도를 넘으면 대기열을 계속 늘리지 않고
`metadata_busy` 또는 `content_busy` 오류를 반환한다. 시간 초과·취소 후에는 HTTP 요청 슬롯을 반환하며, 서버
종료 시 cleanup 대기는 기본 최대 3.1초다. 이 값은 현재 server composition의 기본값이고 어댑터가 작업을 끝내야
하는 무제한 유예가 아니다. 원격 요청 자체의 크기·timeout·동시성도 별도로 제한한다.

예상 가능한 오류는 [catalog.mjs](src/catalog.mjs)의 `SourceError(status, code)`로 전달한다. registry는
400~599 정수 status와 `[a-z][a-z0-9_]{0,63}` 형식 code만 전달하며, 다른 예외의 메시지는
`502 adapter_request_failed`로 바꾼다. code는 고정된 안전한 식별자여야 한다. 원격 응답·URL·key를 code나
로그에 넣지 않는다. 예를 들어 scope가 맞지 않는 회차에는 `404 not_found`, 변경된 catalog snapshot에는
`409 source_catalog_changed`를 사용할 수 있다. 자동 재시도 여부를 어댑터가 무제한으로 결정하지 않는다.

## 새 어댑터 추가 순서

1. `src/`에 검토 가능한 모듈과 factory를 작성해 ABI 네 메서드를 구현한다. ID·scope·pagination·revision 계약을
   먼저 정하고, 원격 origin과 접근 경로를 모듈의 명시적 경계로 제한한다.
2. 임시 합성 metadata·TXT와 주입한 fake HTTP·본문 공급자로 본문 보존, 다른 작품 ID 거부, cursor 순환·변경,
   크기 제한, 취소, 안전한 오류를 검사한다. 사용자 원문이나 실제 credential을 fixture로 저장하지 않는다.
3. composition 모듈의 알려진 factory 목록에 등록하거나 코드에서 직접 factory를 import하여
   `additionalAdapters`에 전달한다. static catalog는 기존대로 등록되므로 별도 모듈을 추가하기 위해 Moya UI나
   공통 route를 복사할 필요가 없다.

   ```js
   import { createTextSourceServer } from './src/server.mjs';
   import { configuredSourcesFromEnvironment } from './src/source-configuration.mjs';
   import { createMySourceAdapter } from './src/my-source-adapter.mjs';

   const configured = await configuredSourcesFromEnvironment(process.env);
   const server = await createTextSourceServer({
     catalogFile: './data/catalog.json',
     sourceRoot: './data/content',
     serverKey: process.env.SERVER_KEY,
     contentProvider: configured.contentProvider,
     additionalAdapters: [
       ...configured.additionalAdapters,
       createMySourceAdapter({ contentProvider: configured.contentProvider }),
     ],
   });
   server.listen(9970, '127.0.0.1');
   ```

   `createMySourceAdapter`는 새로 작성할 factory의 예시 이름이다. 동적으로 받은 경로나 설치 패키지를 의미하지
   않는다. 사용하려는 구현을 직접 검토해 서버 조립 코드에 등록한다.

4. [어댑터 계약 테스트](test/adapter-contract.test.mjs)와 해당 어댑터의 집중 테스트를 실행한다. 연결·본문 import의
   실제 운영 증거가 필요하다면 별도 승인된 검증으로 기록한다. 소스 추가 코드와 live 검증 완료 상태를 구분한다.
