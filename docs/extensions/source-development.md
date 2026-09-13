# JS/TS 소스 개발과 `.moyaext` 배포

상태: JS/TS 개발 도구·source SDK·Hosted 설치/소스 연결 구현 / 2026-09-12. Native 단독 실행은 후속이다.

소스는 일반 JS/TS로 작성한다. `.moyaext`는 실행 언어가 아니라 JS bundle, manifest, 라이선스, 무결성 정보를
담는 ZIP 설치 파일이다. 초기 문서의 `.moyapatch`는 이전 작업명이다. wire format의
`moya.extension.package` v1과 서명 도메인은 바꾸지 않는다.

## 폴더와 명령

복사해 시작할 예제는 `packages/extension-runtime/examples/text-catalog`와 `image-catalog`다.
`manifest.json`, `LICENSE`, `src/index.ts` 또는 `src/index.js`가 필요하다. 경로는 저장소 루트를 기준으로 한다.
개발에는 저장소 의존성을 설치한 Node/Corepack 환경을 사용한다. 앱 사용자에게 이 도구를 요구하는 설계는 아니다.

```sh
corepack pnpm extension:dev check packages/extension-runtime/examples/text-catalog
corepack pnpm extension:dev run packages/extension-runtime/examples/text-catalog
corepack pnpm extension:dev run packages/extension-runtime/examples/text-catalog --method source.getContent --input packages/extension-runtime/examples/text-catalog/content-input.json --fixture packages/extension-runtime/examples/text-catalog/fixtures.json
corepack pnpm extension:dev run packages/extension-runtime/examples/image-catalog --method source.getContent --input packages/extension-runtime/examples/image-catalog/content-input.json --fixture packages/extension-runtime/examples/image-catalog/fixtures.json
corepack pnpm extension:dev pack packages/extension-runtime/examples/text-catalog --out example-text.moyaext
```

`check`는 bundle/manifest/ZIP 검증 후 네트워크 없는 실제 격리 실행기에서 descriptor를 대조한다.
`run`은 현재 폴더를 다시 읽고 같은 실행기·권한·응답 검증을 사용한다. 앱에 재설치하거나 배포 파일을 수동으로
만들 필요가 없다. `pack`만 디스크에 설치 파일을 쓴다. 기존 출력은 덮어쓰지 않는다. 동일한 unsigned 입력은
같은 패키지 digest를 만들도록 ZIP timestamp를 고정했다. 서명은 builder API에서 지원하며 CLI key 관리 UI는 후속이다.

기본 실행은 offline fixture만 사용한다. 실제 요청은 개발자가 `--network`를 명시한 경우에만 허용하며,
그때도 manifest의 HTTPS origin·DNS·redirect 검사를 유지한다. fixture의 `body`는 UTF-8 문자열,
`bodyBase64`는 PNG 등 host가 읽는 바이너리 표현이다. 둘을 동시에 지정하지 않는다. 본문 바이트는 터미널에
출력하지 않고 길이·hash·형식과 scoped handle만 표시한다. 예제는 합성 데이터이며 실제 서비스를 주장하지 않는다.

## SDK와 계약

`@moya/extension-sdk`는 독립 ESM/TypeScript 선언 패키지로 빌드할 수 있다. npm에 게시하지는 않았으며,
[SDK 배포 안내](../../packages/extension-sdk/README.md)의 tarball을 별도 프로젝트에 설치하면 저장소 경로 alias 없이
IDE/타입 검사와 SDK 호출을 사용할 수 있다. 기존 `check/run/pack`은 같은 원본 SDK를 주입하므로 기존 예제는 유지한다.
이 CLI의 독립 배포와 프로젝트 생성 명령은 후속 단계다. SDK만 설치했다고 임의 HTTP/인증 서버 실행 권한이 생기지 않는다.

```ts
import { defineExtension, defineSource } from '@moya/extension-sdk';
export default defineExtension({
  sources: [
    defineSource({
      id: 'org.example.my-source.catalog',
      // listWorks, getWork, listReleases, getContent 구현
    }),
  ],
});
```

- 작품·회차는 사이트의 안정된 ID를 반환한다. 표시 제목이나 목록 index를 ID로 사용하지 않는다.
- 목록은 최대 500개와 opaque `nextCursor`를 반환한다. 회차 `order`는 사이트의 최신순/오래된순 표시와
  무관한 읽기 순서다. 다음 페이지가 없어졌다면 cursor를 생략한다. 조회 중 회차를 임의로 재번호 매기지 않는다.
- catalog의 `subscriptions` capability를 선언하면 다운로드 전 라이브러리 추가와 새 회차 확인에 기존 호스트
  기능을 사용한다. 예제도 이 기능을 선언한다. 소스가 별도 Library DB나 구독 저장소를 구현할 필요는 없다.
- `getContent`는 UTF-8 TXT의 host asset 하나 또는 순서가 있는 이미지 asset 배열이다. TXT 직접 다운로드는
  `http.asset`, HTML/JSON에서 추출한 본문은 `textAsset`을 사용한다. 이미 받은 TXT를 trim/개행 변환하지 않는다.
- `getCover`는 선택 구현이고 host asset 또는 `null`을 반환한다. 원격 URL을 UI에 직접 넘기지 않는다.
- `http.text`와 `http.asset`은 같은 host broker를 사용한다. Node/global fetch/DOM/파일/쿠키/Library DB 접근은 없다.
  인증 실패는 `source_auth_required`이고, 검색 결과가 없는 경우에는 정상적인 빈 `items`를 반환한다.
- SDK를 우회한 JS도 host result validator와 asset 소유권·길이·hash 검사를 통과해야 한다. TypeScript 타입만
  믿고 Library/importer에 값을 넘기지 않는다. SDK 라이선스 고지는 패키지에 자동 포함한다.

## Hosted installation

업데이트된 모야 서버에 로그인한 뒤 **설정 → 익스텐션 → 설치형 확장 → 확장 파일 추가**에서 `.moyaext`를 선택한다.
이름·버전·접근 도메인을 확인하고 설치하면 기존 소스 목록에 나타난다. 동일 ID의 새 파일로 업데이트할 수 있고,
관리 메뉴에서 이전 버전 복원·제거가 가능하다. 제거해도 이미 내려받은 작품과 읽기 위치는 유지한다.
게시자 변경과 이전 버전 설치는 추가 확인을 거친다. 서명이 있다고 공식 배포자로 인증되는 것은 아니다.

실행기는 서버 배포 의존성에 포함하고, 설치 정보는 migration 0046의 별도 PostgreSQL 테이블에 저장한다.
기존 서버 로그인과 인증된 API를 사용하므로 설치 기능을 위해 별도 소스 서버 주소나 키를 입력할 필요는 없다.
패키지 코드·비밀정보를 일반 설정/책장 동기화에 섞지 않는다. 초기 조회, 설치 변경 후, 1분 이상 지난 창 포커스 시
설치 목록을 확인하며 주기적인 폴링은 하지 않는다. 다른 기기에선 새로고침으로 즉시 확인할 수 있다.

현재 실행 가능한 패키지는 v2 catalog 형식의 텍스트·이미지 소스이며 아래의 일반 저장 API도 지원한다.
메타데이터 contribution이 필요한 패키지는 아직 설치 준비 단계에서 거절한다. 순수 정적 Web에는 서버 설치 화면이 없으며,
Windows 기기 설치는 아래 경로로 연결했다. 로그인 필요한 소스 SDK는 아직 남아 있다.

검증 명령 `corepack pnpm check:extension-ui`는 격리한 PostgreSQL과 실제 실행기로 설치/업데이트/되돌리기,
파일 다운로드와 390/768/1024px UI를 확인한다. `corepack pnpm check:extension-app`은 실제 App 빌드에서
Hosted 소스와 로컬 Library를 연결해 검색·라이브러리 추가·일괄 다운로드·읽기·제거 후 읽기까지 검증한다.
서버의 Library/object storage 전체 경로와 Native 설치 파일 검증은 별도다.

## Windows 기기 설치와 실행기 빌드

서버에 연결하지 않은 Windows desktop은 같은 설치 화면에서 **이 기기**에 설치한다. 설치 archive와 이전
버전은 별도 IndexedDB에 보관하고, 앱에 포함한 실행기가 소스를 처리한다. Node 설치나 서버 주소·토큰 입력은
필요 없다. 서버에 연결한 앱은 기존 Hosted 설치 대상을 사용한다. 두 대상 동시 선택 UI는 아직 제공하지 않는다.

개발 빌드는 먼저 `corepack pnpm extension:bundle-native`를 실행한다. Windows 배포 빌드는
`tauri.windows.conf.json`의 build hook에서 자동 실행한다. 공식 Windows x64 Node 22.23.2 ZIP의 고정 SHA-256을
검증하고 필요한 Node 실행 파일·QuickJS runtime/의존성·라이선스만 `src-tauri/extension-sidecar/`에 생성한다.
생성물은 Git에 넣지 않는다. 개발 환경의 Node와 PATH에 의존해 실행하지 않는다. Windows 전용 설정이므로
Android의 build hook/resources에는 Windows 실행기를 추가하지 않는다. macOS/Linux desktop은 미지원이다.

실행은 Tauri → 앱 전용 loopback host → 별도 QuickJS guest 프로세스 순서다. 실행기 연결 토큰은 앱이 자동으로
생성해 stdin으로 전달하며 UI에 입력·출력하지 않는다. HTTP에는 정확한 Host/Origin과 토큰 검사를 적용한다.
archive를 다시 검증한 뒤 활성화하고, 바이너리는 JSON/base64 대신 길이를 제한한 binary 응답으로 전송한다.
요청 취소와 앱 종료는 실제 guest 종료까지 기다린다. guest에는 OS·파일·Library DB·인증 쿠키 접근이 없다.

검증 명령:

```powershell
corepack pnpm extension:bundle-native
corepack pnpm check:extension-native
corepack pnpm check:extension-app --native
```

첫 검사는 묶인 실행기만으로 원문 바이트·캐시 재준비·취소·종료를 확인한다. 두 번째는 실제 App/IndexedDB와
같은 묶인 실행기로 설치·검색·일괄 다운로드·읽기·업데이트·제거를 확인한다. 이 브라우저 검사는 Tauri의 프로세스
시작 호출만 테스트 어댑터로 대체하므로, NSIS 설치 후 실제 WebView2 실행 검증을 대신하지 않는다.

## 소스별 일반 데이터 저장

manifest의 `requestedAccess.storageKiB`를 1~1024로 선언하면 `context.storage.get/set/remove`를 사용할 수
있다. 0은 저장 권한 없음이다. 설치 화면에 용량을 표시하며, scope는 소유자·설치 대상·package·source로 나뉜다.
주소 후보, 조회 상태, 작은 캐시처럼 **비밀이 아닌 JSON**에 사용한다. 비밀번호·세션·접속 토큰은 저장하지 않는다.

```ts
async listWorks(input, { storage }) {
  const previous = await storage.get('catalog-state-v1'); // 없으면 null
  // 공개 목록을 조회하고 상태가 실제로 달라졌을 때만 저장한다.
  await storage.set('catalog-state-v1', { cursor: 'opaque-cursor' });
  // 필요 없어진 키는 await storage.remove('old-key')로 지운다.
  return { items: [] };
}
```

- 한 값은 최대 64 KiB, 키는 영문·숫자·점·밑줄·하이픈 1~80자다. package의 전체 소스가 선언한 총용량을
  나눠 쓰고 최대 1024개 키를 저장한다. 깊이 24 초과 JSON, 유한하지 않은 숫자, NUL/짝이 없는 UTF-16 문자는
  서버·기기에서 동일하게 거절한다. 정상 한글·이모지는 그대로 보존한다.
- 각 호출은 저장값의 snapshot으로 시작한다. `set/remove`는 임시 변경이며, 결과와 asset 검증에 성공하고
  같은 설치 revision이 유지돼야 한 번에 저장한다. 취소는 commit 진입 전과 DB 대기 중에도 확인한다.
  이미 완료된 commit을 나중의 취소나 다운로드 파일 전송 실패가 되돌리는 것은 아니다.
- 서로 다른 키를 바꾸는 병렬 다운로드는 합쳐 저장한다. 같은 키를 읽거나 덮어쓰는 작업이 충돌하면
  `source_storage_conflict`를 반환하고 일부 변경만 저장하지 않는다. 소스는 다운로드마다 공용 카운터를
  갱신하기보다 필요한 키만 변경해야 한다. 외부 요청을 무조건 다시 실행하는 자동 재시도는 하지 않는다.
- 같은 게시자의 업데이트·이전 버전 복원·끄기/켜기에서 보존한다. 코드 rollback이 일반 데이터까지 과거로
  돌리지는 않는다. 값 구조가 바뀌면 version을 포함한 키를 사용한다. 용량이 줄어도 오래된 값을 단계적으로
  줄이거나 삭제할 수 있다. 제거·게시자 변경 때는 지우고, 이전 실행의 늦은 저장도 차단한다.
- 데이터 변경으로 설치 revision·registry를 갱신하지 않는다. 따라서 cache 저장이 리더 재마운트나 설치 목록
  재조회를 유발하지 않는다. 일반 책장 backup/설정 동기화에도 source state를 포함하지 않는다.
- Hosted는 migration 0047의 별도 `source_state` 열, 기기는 확장 전용 IndexedDB v2의 별도 object store를
  사용한다. 기존 설치 정보는 그대로 이관한다. 개발 `runProjectSource(..., {state})`는 snapshot과 `stateChanges`를
  검증에 사용할 수 있다. CLI `run`은 매번 빈 임시 상태로 시작하고 실제 기기/서버 상태를 수정하지 않는다.

## 인증 연결

`requestedAccess.authentication`에 소스별 연결을 선언한다. 일반 source storage에 인증값을 넣지 않는다.

```json
{
  "sourceId": "org.example.catalog.source",
  "label": "계정 연결",
  "origin": "https://catalog.example",
  "scheme": "cookie",
  "cookieName": "SESSION",
  "verification": { "path": "/account", "field": ["account", "authenticated"], "equals": true }
}
```

`origin`은 networkOrigins에 포함돼야 한다. `scheme`은 `cookie`, `bearer`, `basic`을 지원하며 `cookieName`은
cookie에만 필요하다. basic은 HTTP Basic이며 사이트 로그인 폼 제출을 의미하지 않는다. 검증은 같은 origin의
GET JSON endpoint에서 field 경로 값이 equals와 정확히 일치해야 한다. 단순 200이나 검색 결과만으로 검증하지 않는다.

사용자는 확장 설정의 계정 연결에서 확인 후 저장한다. 저장한 값은 host의 암호화 vault에 남고 guest가 읽을 수 있는
API는 없다. `context.http.text/asset({url, authenticated: true})`를 사용하면 host가 해당 소스 연결을 주입한다.
로그인이 필요 없는 요청에는 이 옵션을 생략한다. 인증 요청의 다른 origin redirect는 거절하며 CDN으로 전달하지 않는다.
미설정/만료는 `source_auth_required`, 인증 요청의 권한 부족은 `source_auth_forbidden`이다. 개발 CLI는 저장된 실제
계정을 읽지 않는다. 인증 정보는 설치 상태·일반 설정과 분리된 host vault에 보관한다.

## 저장소 등록·설치·업데이트

확장 설정의 **저장소**에서 Moya 저장소 JSON 주소를 추가하면 아직 설치하지 않은 확장도 검색하고 설치할 수
있다. 설치 여부와 새 버전을 표시하며 **업데이트만 표시**로 좁힐 수 있다. 파일은 먼저 다운로드·검증한 뒤
기존 권한/게시자 검토 화면으로 넘긴다. 확인 없이 설치하거나 실행하지 않는다.

저장소 목록과 마지막으로 가져온 index는 Hosted에서는 사용자별 서버 DB, Windows 기기에서는 확장 전용
IndexedDB에 보관한다. 재실행 후 저장한 목록을 즉시 보여 주고 **목록·업데이트 확인**을 눌러 갱신한다.
갱신 실패 시 기존 목록을 유지한다. 최대 16개 저장소, 목록 페이지당 20개 확장이며 정기 폴링은 없다.
저장소 삭제는 설치한 확장·계정 연결·받은 작품을 지우지 않는다. 삭제 중이던 과거 조회가 끝나도 되살아나지 않는다.

서버에는 migration **0048**이 필요하다. 기기 DB는 v2에서 v3으로 설치/소스 데이터를 보존하며 이관한다.
이 저장은 일반 책장 백업·기기 설정 동기화와 별개이며 목록 갱신으로 소스 실행기나 리더를 다시 시작하지 않는다.

manifest에 `"updates": {"repository": "https://catalog.example/extensions/index.json"}`을 추가하면 확장 설정의
관리 메뉴에 **업데이트 확인**이 나타난다. 저장소는 다음 JSON을 제공한다.

```json
{
  "format": "moya.extension.repository",
  "version": 1,
  "name": "예제 확장 저장소",
  "packages": [
    {
      "id": "org.example.catalog",
      "version": "1.1.0",
      "name": "예제 소스",
      "description": "텍스트 작품 검색과 회차 다운로드",
      "archive": "./catalog-1.1.0.moyaext",
      "sha256": "<패키지 파일 전체의 SHA-256 64자리 소문자>"
    }
  ]
}
```

- 저장소는 HTTPS이며 최대 256개 package의 최신 버전을 나열한다. package ID는 중복할 수 없다.
  저장소/확장 `name`(120자), 확장 `description`(500자)은 선택 사항이다. 생략하면 URL/ID를 표시한다.
  상대 archive 경로는 index URL을 기준으로 해석한다. archive와 redirect는 같은 origin에 있어야 한다.
  GitHub를 사용할 때는 index와 `.moyaext`를 같은 raw.githubusercontent.com origin에 놓을 수 있다.
  다른 origin으로 redirect하는 release CDN/미러는 현재 지원하지 않는다.
- index는 256 KiB 이하, 설치 archive는 10 MiB 이하다. host가 public DNS/IP 정책을 적용해 가져오며
  소스 계정 인증·모야 토큰을 외부 저장소로 전송하지 않는다. UI에서 원격 코드를 실행하지 않는다.
- 현재보다 높은 버전만 후보로 받는다. 파일 전체 hash, package ID, 버전, archive 내부 integrity/서명과 기존
  게시자 pin을 확인한다. 게시자 변경은 저장소 업데이트에서 거절하며 파일 추가의 명시적 검토로 처리한다.
- 확인만으로 적용하지 않는다. 기존 설치 화면에서 변경된 권한·인증 주소·게시자를 검토하고 업데이트한다.
  설치 CAS, 취소, 이전 버전 복원, Reader/원문 보존 경로를 그대로 사용한다. 확인 중 설치가 바뀌면 재시도한다.
- 타이머/백그라운드 자동 설치는 없다. 최초 설치는 파일 또는 등록한 저장소에서 진행한다. manifest에
  `updates.repository`가 없는 패키지도 등록한 저장소의 같은 ID 새 버전으로 업데이트할 수 있다.
  다운로드 중 원격 index가 바뀌어도 사용자가 선택한 파일 hash를 사용하며 임의의 최신 파일로 바꾸지 않는다.
  새 인증/updates 선언이 있는 패키지는 이 계약을 지원하는 앱/서버 버전이 필요하다.

**호환 범위:** 이 저장소는 Moya SDK로 작성한 `.moyaext` 배포용이다. Suwayomi APK/index나 기존 텍스트 서버
adapter `.mjs`를 그대로 설치하는 기능은 아니다. 기존 소스는 기존 서버 연결로 계속 사용할 수 있다.
텍스트 adapter의 SDK 이식과 Suwayomi 호환 엔진 관리·기존 작품 식별자 이관은 별도 후속 작업이다.

## 선택형 외부 본문 서비스

인증/본문 서버가 필요한 소스만 manifest의 `requestedAccess`에 선언한다. 공급자 이름·endpoint·key는 넣지 않는다.

```json
"contentServices": [{"sourceId":"org.example.catalog.source","version":1,"origins":["https://catalog.example"]}]
```

원본 origin은 `networkOrigins`의 부분집합이어야 한다. 다운로드 권한과 텍스트 document-series 소스가 필요하다.
`getContent`는 작품/회차 소속을 검증한 뒤 SDK의 `providerText(url)`를 반환한다.

```ts
import { providerText } from '@moya/extension-sdk';
// getContent 내부: 입력 ID로 확인한 회차만 허용하고 원본 URL을 구성한다.
return providerText(verifiedChapterUrl);
```

host는 guest 종료 후 승인된 provider를 실행하고 기존 text asset을 반환한다. 긴 작업이 guest 실행 시간에 포함되지
않고 본문/키가 guest로 돌아오지 않는다. 95초 작업 기한, 2 MiB/UTF-8 본문 검증, 취소와 원문 byte 보존을 적용한다.
같은 host의 동시 provider 작업은 최대 2개다. 기존 `job-v1`의 90초 작업/독립된 3초 close를 그대로 사용한다.

Hosted 운영자는 기존 `CONTENT_PROVIDER_ENDPOINT/KEY/PROTOCOL`을 그대로 두고 다음 승인 정보만 추가한다.

```dotenv
EXTENSION_CONTENT_BINDINGS='[{"ownerId":"user_dev","packageId":"org.example.catalog","sourceId":"org.example.catalog.source","digest":"<검토한 moyaext 전체 SHA-256 64자리>","provider":"default","origins":["https://catalog.example"]}]'
```

- `ownerId`는 서버 `DEFAULT_USER_ID`와 같아야 한다(미설정 기본 `user_dev`). 다른 소유자의 연결은 선택하지 않는다.
- `digest`는 `extension:dev pack`이 출력한 정확한 archive hash다. 파일이 바뀌면 다시 승인해야 한다.
  서명된 배포는 `digest` 대신 `publisherFingerprint`를 지정할 수 있다. 둘 중 하나만 허용하며 ID만으로 승인하지 않는다.
  게시자 pin 방식은 같은 게시자의 업데이트에 유지되지만 허용 source/origin은 여전히 운영 설정으로 제한한다.
- `provider: "default"`는 기존 전역 연결을 사용한다. 이름 있는 기존 `CONTENT_PROVIDERS` 연결도 선택할 수 있다.
  이 연결 ID는 host 설정에만 있으며 SDK가 지정하지 않는다. 승인 없음은 안전한 연결 필요 오류이고 자동 fallback은 없다.
- `compose.text-sources.yaml`은 기존 공급자 환경 설정과 승인 목록을 API에 전달한다. 다른 배포는 API 프로세스에도
  기존 설정을 주입해야 한다. 별도 companion 컨테이너의 환경은 API가 자동으로 읽을 수 없다. 운영 설정은 source/package
  저장소나 책장 백업에 넣지 않는다. 새 설정을 적용하려면 API를 재시작한다.
- 공급자 endpoint는 운영자가 관리하는 local/self-host 주소일 수 있다. 회차 URL은 public HTTPS/DNS/IP와 선언/
  운영 승인 origin에 한정한다. guest의 일반 HTTP 권한을 내부망으로 넓히지 않는다.
- 공급자 인증 오류는 원래 사이트의 계정/이용 권한과 별개다. 연결 성공만으로 사이트 로그인을 보장하지 않는다.
  오류에는 endpoint/key/응답 본문을 포함하지 않는다.

실행 예제는 `packages/extension-runtime/examples/provider-text`다. `check`/`pack`은 기존 개발 도구를 사용한다.
본문의 오프라인 검증은 `runProjectSource(..., {contentResolver: async (...) => syntheticBytes})`로 명시적으로 주입한다.
CLI `run`은 실제 운영 연결/비밀값을 자동으로 읽지 않으며 주입 없이 본문을 요청하면 연결 필요 오류를 반환한다.
`corepack pnpm check:extension-app --content-service`는 실제 Hosted App을 통한 합성 provider 회귀 검사다.

Windows binary 전송과 host 주입은 검증했지만 Tauri 기본 시작 경로의 사용자용 연결 설정은 아직 후속이다.
기존 외부 소스/작품의 자동 이관은 하지 않으며 별도 이관 단계 전에는 같은 작품을 자동으로 합치지 않는다.

## 현재 제약과 다음 단계

별도 인증/본문 서버는 모든 텍스트 확장의 필수 조건이 아니다. 직접 HTTP 취득은 현재 SDK로 가능하며,
긴 본문 취득 작업이 필요한 소스의 선택형 host 서비스 연결과 후속 UI/이식은
본문 공급자는 선택형 연결이며, 패키지가 선언한 경우에만 사용자가 해당 연결을 설정한다.
기존 서버의 소스별 공급자 분리와 설치형 SDK/host 실행은 구현했다. 사용자용 연결 선택 UI와 Windows 기본
실행 경로의 운영 연결 설정은 후속 단계다.

이 첫 도구는 프로젝트 내부의 정적 JS/TS/JSON import와 SDK를 지원한다. Node 모듈, 동적 import, 프로젝트 밖
파일 및 build plugin/npm script 실행은 거절한다. 외부 pure JS 라이브러리는 현재 프로젝트 내부에 라이선스와
함께 포함해야 한다. npm dependency 해석·고지 자동화, watch/앱 개발 연결, init 템플릿과 더 나은 오류 위치 표시는 후속이다.

응답 text parsing은 256 KiB, asset은 16 MiB, invocation 전체 asset/in-flight는 32 MiB다. 이 범위를 넘는
실사용 만화는 streaming asset 수명과 저장소 연결 작업이 필요하다. 일반 로그인 폼/세션 갱신과
Windows 설치 파일의 최종 실사용 검증은 남아 있다. 표지·메타데이터는 기존 기본 제공 수집기를 유지한다.

개발 검사 통과가 앱의 설치→검색→다운로드→읽기 E2E 통과를 의미하지 않는다.
패키지 형식과 host 경계는 [설치형 확장 구조](../architecture/moyapatch-extension-packages.md)에 기록한다.

## Installed text connection and legacy migration (2026-09-13)

### Direct content versus an optional browser/content helper

An installed text extension does not require the old text catalog server. `getContent` can return
`{kind: 'text', asset: await ctx.http.asset({url})}` for a TXT response, or use `ctx.textAsset(parsedText)`
after parsing a supported page. Return `providerText(chapterUrl)` only for a site whose implementation
needs the optional host content service. Declaring `contentServices` grants that capability; it does
not force every download through the helper. Do not return a loading/error HTML page as a novel.

The saved per-source connection now constructs a named job-v1 connection directly. It no longer fabricates
`CONTENT_PROVIDER_ENDPOINT/KEY` or `EXTENSION_CONTENT_BINDINGS` environment settings. Existing operator
bindings remain supported separately for deployed installations. Moya owns its generic job-v1 HTTP client;
its production build no longer copies or imports the older text catalog server implementation. The older
server retains its own compatibility client and is not required to run an installed source.

Live verification on 2026-09-13 distinguished page access from content access: a private source returned
HTTP 200 for both the chapter page and session issuance, but its direct content request returned
HTTP 403 with `blocked` and no payload. The page contained a loading view. The previously tested helper
route downloaded readable content. Thus this private adapter still requires a working helper for the
currently verified path. This does not establish that every possible direct implementation is impossible,
nor that any job-v1 provider supports every site. It also does not prove an AdGuard/VPN root cause.

Do not add speculative direct-first requests on every chapter of that adapter: a known failing request
would only add latency. A direct implementation must first demonstrate successful content extraction
and preserve the text; then it can replace or complement `providerText` in the private package.

The local live helper uses the existing data volume/key and a temporary internal proxy. That local wiring
is not a portable, finished deployment bundle. Provider-free live extraction, durable migration of that
local wiring, and clean-machine desktop/self-host deployment remain unverified.

`contentServices` remains optional. The host supports a per-source endpoint with an optional upstream key,
verified with job-v1 health and encrypted in the existing source vault. A configured operator binding takes
precedence and is shown as managed; it does not ask users to enter the same credentials again. Guest code
receives neither endpoint settings nor keys. This is not a shared connection-profile manager.

Hosted source management exposes `POST /api/extensions/sources/:id/content-connection` with
`{action:"status"}`, `{action:"save",endpoint,key?}` or `{action:"remove"}`. Status returns
`configured`, optional `endpoint`/`keySaved`, or `managed:true`; no key is returned. Native uses the same
contract through its authenticated loopback host. Saving/removing invalidates active source execution.

[Existing text identities and deployment](../operations/installed-text-source-migration.md) describe the
operator-owned migration bridge. Package manifests cannot claim existing library identities.
