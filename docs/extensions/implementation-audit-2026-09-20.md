# 확장 구현·완료 보고 대조 검토

검토일: 2026-09-20. 대상: `fix/extension-install-update-covers` 작업 트리의 설치 신뢰성,
Mangayomi P0/HTTP 호환, 자체 SDK·CLI와 공개 배포 도구. 운영 서비스에는 반영하지 않았다.
이 검토는 모든 사이트·플랫폼에 대한 호환성 인증이 아니다.

## 결론

앞서 보고한 CLI/SDK·서명·index 기능은 실제 구현되어 있다. 하지만 공개 플랫폼 전체 완성으로
확대 해석하면 안 된다. 배포 산출물 관리 결함과 자동 검증 연결 누락이 있었으며 아래처럼 수정했다.
실제 사이트 본문 취득, 미지원 호환 API, 공개 배포·문서화된 지원 운영은 여전히 남아 있다.

## 발견하고 수정한 부분

| 중요도 | 발견                                                                                                  | 조치·증거                                                                                                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 높음   | SDK·CLI 빌드가 기존 `dist`에 덧쓰기만 했다. 삭제된 코드/진단 파일이 다음 tarball에 포함될 수 있었다.  | 두 `dist`에 비밀이 아닌 marker를 넣어 재빌드 후 남는 것을 재현했다. 각 패키지의 생성 출력 디렉터리만 새로 만들도록 수정했고 회귀 검사에서 marker 제거를 확인한다. APK 설치 archive나 사용자 프로젝트 삭제 로직은 추가하지 않았다. |
| 보통   | CLI 빌드가 템플릿 디렉터리를 통째로 복사했다. 개발 중 추가한 파일까지 배포 대상이 될 수 있었다.       | 생성 명령이 실제로 사용하는 manifest/entry/fixture/LICENSE만 복사하고, runtime도 자체 package의 배포 파일 목록을 따른다.                                                                                                          |
| 보통   | `test:extension-cli`는 존재했지만 기존 CI의 `test:extensions-sources`에서 실행하지 않았다.            | 확장 검사 명령 끝에 연결했다. `hosted-source → check:web-server → test:extensions-sources` 경로로 실행된다. 이번 작업 트리로 GitHub CI를 실행한 것은 아니다.                                                                      |
| 보통   | 기존 CLI 설치 테스트는 npm `bin`을 거치지 않고 내부 JS 경로를 실행했다.                               | 설치된 `moya-extension`을 `npm exec --offline --no`로 실행해 사용자 명령 경로를 검증한다. 생성 README도 로컬 설치에 맞게 `npx --no-install`을 사용한다.                                                                           |
| 보통   | 새 CLI 키의 서명 검사는 archive 검증까지였다. 같은 키의 실제 설치·업데이트·재시작 연결 검사는 없었다. | 실제 PackageInstaller/IndexedDB store에 1.0.0 설치→비활성화→1.1.0 업데이트→store 재개방을 실행한다. 게시자 pin·비활성 상태·이전 버전 보존과 미승인 다른 키의 1.2.0 거절을 검사한다. hosted DB/실사용 작품 검증과는 구분한다.      |

주요 수정: [CLI 빌드](../../packages/extension-cli/build.mjs),
[SDK 빌드](../../packages/extension-sdk/build.mjs),
[독립 설치 검사](../../packages/extension-cli/build.test.mjs),
[서명 설치 검사](../../scripts/extensions/signing.test.ts), [검사 연결](../../package.json).

## 약속과 실제 구현 상태

| 항목                                     | 상태                     | 근거·남은 한계                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 독립 SDK/CLI                             | 구현·로컬 검증 완료      | 실제 tarball을 checkout 밖에 설치. NodeNext/Bundler 타입·실행과 text/images init/check/run/pack/index 확인. SDK 단독 자동 검사는 복사 설치 방식이며 CLI tarball 검사는 실제 npm 설치다. 별도 Node 22 컨테이너에서는 두 tarball 모두 실제 npm 설치했다. |
| 게시자 키·서명                           | 구현·추가 연결 검사 완료 | 기존 ECDSA-P256-SHA256 형식 유지. PEM 파일·서명된 archive의 설치/업데이트와 게시자 변경 거부 확인. HSM/KMS·키 복구 UI는 없다.                                                                                                                          |
| 공개 저장소 목록                         | 구현·검증 완료           | 실제 archive hash/version 기반, 중복 ID·잘못된 archive·update URL 불일치 거부. 업로드는 수행하지 않는다.                                                                                                                                               |
| Mangayomi 문자열/DOM/기본 설정/소설 정리 | 구현·회귀 검사 완료      | 고정 revision의 원본 3개와 API 경계 검사. 전체 원본 카탈로그 무수정 호환을 검증하지 않았다.                                                                                                                                                            |
| HTTP 옵션/중단/세션                      | 구현·관련 검사 통과      | PATCH, redirect, 실제 stalled body/DNS 취소, cookie 연결. native client 전체 옵션과 동일한 API는 아니다.                                                                                                                                               |
| 실제 Mangayomi 소스의 목록→본문→읽기     | 부분 검증                | 후속 MangaDex 실사이트 첫 이미지 취득과 고정 HTTP 응답을 사용한 App 읽기는 각각 통과했다. 실사이트 전체 회차→App 읽기와 모든 언어/작품은 미검증이다. 기존 원본 2개의 도메인 이동/404 실패를 덮어쓰지 않는다.                                           |
| 광범위한 Mangayomi 호환                  | 원본 23개 정적 분류 완료 | 현재 corpus에서 확인한 AES helper를 구현했다. EPUB, 평문 HTTP, 로그인 전제 소스는 명시적 제한이며 사이트 selector 노후화는 host 기능 부족과 구분한다.                                                                                                  |
| 개발 편의                                | 로컬 preview까지 완료    | init/check/run/dev/preview/pack/keygen/index와 SDK v1 참조 제공. preview는 fixture 기본, 127.0.0.1 전용이며 마지막 정상 결과와 빌드 오류 위치를 유지한다. 본문·이미지 바이트는 렌더링하지 않는다. 실제 App 자동 실행과 브라우저 debugger 연결은 없다.  |
| npm/공개 릴리스·PR·운영 배포             | 공개 게시 전             | package는 `private: true`이고 서명 가능한 SDK/CLI tarball과 저장소 산출물을 로컬에서 준비했다. npm/GitHub Release 게시와 운영 배포 성공을 주장하지 않는다.                                                                                             |
| APK 호환                                 | 별도 제한 기능           | 과거 격리 실행 결과 파일은 존재하며 16개 설치·31개 고유 소스 결과와 실패 원인이 기록되어 있다. 이번에는 APK 사이트별 실행을 재검사하지 않았다. 이전에 거부한 orphan cleanup/async discard 변경은 현재 diff에 없다.                                     |

## 이번 검증 결과

- 수정 전 작업 트리의 관련 Vitest: **26파일, 115개 통과**. 설치 UI/manager, Mangayomi,
  HTTP session, 프로젝트/서명/index, package 설치/검증 경로를 포함한다.
- 수정 후 영향 범위인 서명·scaffold: **7개 통과**. 앞의 115개와 중복되므로 합산하지 않는다.
- 수정 후 독립 배포 검사: **Node 테스트 2개 통과**. 오래된 산출물 제거,
  SDK 외부 타입·실행, 실제 CLI npm 설치·bin 실행·서명·index 생성.
- 추가 플랫폼 확인: 기존 `node:22-bookworm-slim` 이미지의 **Node 22.23.2** 격리 컨테이너에
  새 CLI/SDK tarball을 실제 설치해 text/images 전 과정을 통과했다. 로컬 검사는 Node 24.13.1이다.
  최저 요구 버전인 22.12 자체와 Windows의 npm 도구 실행은 이번에 검사하지 않았다.
- server/scripts TypeScript, 변경 도구 ESLint/Prettier, `git diff --check` 통과.

도구 배포 시험은 합성 text/PNG fixture를 사용한다. 운영 계정/DB/컨테이너를 사용하지 않았다.
타입 검사와 코드 검토 통과만으로 현재 앱의 모든 화면이나 사이트의 정상 동작을 보증하지 않는다.

## 공개 준비 판단

현재는 **외부 개발자가 제한된 지원 범위에서 확장을 작성·패키징할 수 있는 개발자 preview**다.
"Mangayomi급으로 대부분의 확장을 무수정 지원하는 공개 생태계"라는 완료 판단은 이르다.
다음 공개 검증의 기준은 실제 사용할 소스의 검색·회차·본문 취득·앱 읽기와 업데이트를 끝까지
확인하고, 그 소스들이 요구하는 공통 API를 확대하는 것이다. 새 사이트를 임의로 정상 지원 목록에 추가하지 않는다.

## 같은 날 후속 검증에서 확인한 추가 누락

복수 선택·다국어 Mangayomi 작업 중 APK HTTP route 검사까지 포함하자,
`apk-extensions.test.ts`에 과거 폐기한 비동기 discard cleanup을 기다리는 테스트가 남아 있음을 발견했다.
앞선 검토에서 제품의 orphan 삭제 로직이 제거된 것은 확인했지만 이 테스트까지 확인하지 못했다.
비동기 정리 기대를 제거하고 기존 동기 검토 취소·호환 오류 응답 검사는 유지했다. 제품에 삭제 기능을 되살리지 않았다.

후속 묶음은 9파일 50개 통과. 원본 MangaDex의 복수 선택 저장/재개방·다국어 파일 설치와
fixture 이미지 asset 취득을 포함한다. 실제 API에서도 목록→회차→첫 이미지 취득을 별도로 확인했다.
자세한 범위와 한계는 [현재 호환 지원표](mangayomi-compatibility.md)의 후속 절을 참고한다.

## 실제 App 후속에서 확인한 추가 누락

앞선 원본 MangaDex 검사는 목록에서 회차 호출로 바로 넘어갔고 `source.getWork`를 빠뜨렸다.
실제 App은 상세 조회를 거치므로 원본이 상세 제목을 생략하면 기존 제목이 사라지고 작품 열기가
실패했다. 어댑터에 목록 제목 보존을 추가하고 같은 원본 `getWork` 회귀 검사를 수정 전 실패로 확인했다.
파일 설치 후 빈 저장소 탭에 남는 UX도 설치 목록으로 이동하도록 수정했다.

후속 관련 검사 **4파일 21개 통과**, web/server/scripts TypeScript 및 변경 파일 ESLint 통과.
원본 Mangayomi App 검사는 언어 선택·복수 설정·검색·상세·회차 가져오기·모바일 이미지 디코딩과
새로고침 후 재다운로드 없는 재열기를 통과했다. [검사 범위와 실행 명령](mangayomi-compatibility.md)을 참고한다.
이는 설치 API/브라우저 도서 저장소를 사용한 고정 HTTP fixture 검사다. 실사이트 전체 읽기 성공으로
확대하지 않으며 운영 서비스를 변경하지 않았다.

기존 `.moyaext` full App 검사도 설치·회차 가져오기·읽기·업데이트/제거·새로고침 보존까지 다시 통과했다(page errors 0).

## 개발 명령 후속

공개 준비의 개발 편의 단계로 `moya-extension dev`와 `preview`를 추가했다. 프로젝트를 최초 검증한 뒤 파일을 감시하고,
선택한 source method를 offline fixture 또는 명시적인 network 모드로 다시 실행한다. 결과는 목록 첫 5개와
asset type/byte 수만 요약하고 본문·이미지 바이트는 출력하지 않는다. 빌드 오류는 파일·행·열과 해당 줄을,
fixture 누락은 query 값을 제거한 HTTP method·URL 경로를 표시한다.

실제 감시 프로세스에서 정상 실행 → 소스 저장 후 재실행 → 문법 오류 후 프로세스 유지와 위치 표시를 확인했다.
`preview`는 임의의 loopback 포트에서 같은 요약을 보여 주며, 실패 시 마지막 정상 결과를 유지한다. 외부
프로젝트에 실제 tarball을 설치해 init/check/run/preview/서명 pack/index를 확인했다. 실제 Moya App을 자동으로
띄우는 시각적 미리보기와 브라우저 debugger 연결은 이번 범위에 포함하지 않았다.

## 원본 corpus와 실사이트 후속

고정 revision의 manga 18개·novel 5개 JavaScript 파일을 전수 분류했다. 실제 host 전용 helper 사용은
CopyManga의 `cryptoHandler`와 Anna's Archive의 EPUB 두 종류였고, AES-CBC helper를 추가해 결정적 검사를 통과했다.
EPUB은 다운로드·파싱·자산 수명이 필요한 별도 콘텐츠 모델이라 현재 미지원으로 남겼다.

실사이트 최소 검사에서는 MangaDex가 검색→상세→회차→페이지 목록을 통과했고, 격리한 production App에서도
원본 설치부터 실제 3페이지 회차 다운로드·모바일 뷰어 디코딩까지 통과했다. Webtoons, MangaPill,
Web Novel Translations, KolNovel, CopyManga의 결과는 selector/API 변경 또는 안전 응답 한도로 분류했다.
세부 결과와 재현 명령은 [원본 corpus 보고서](mangayomi-corpus-2026-09-20.md)에 있다.
