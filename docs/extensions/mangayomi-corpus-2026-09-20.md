# Mangayomi JavaScript 원본 corpus와 실사이트 판정

기준일: 2026-09-20. 원본 저장소 revision:
[`6004f1f8d1a56f882dadb734ce26f50c626a3850`](https://github.com/kodjodevf/mangayomi-extensions/tree/6004f1f8d1a56f882dadb734ce26f50c626a3850/javascript).
검사는 운영 Moya 설치 상태와 사용자 계정을 사용하지 않았다. 원본 23개 파일은 manga index의
JavaScript 항목 114개와 novel index의 5개 항목으로 확장된다.

## 정적 호환 분류

`기본 호환`은 해당 파일이 사용하는 목록·상세·회차·이미지/HTML, DOM, 설정과 HTTP 표면이
현재 호스트에 있다는 뜻이다. 사이트의 현재 selector와 인증 상태까지 성공한다는 뜻은 아니다.

| 원본 파일                              | 소스 / 버전                  | 형식              | 현재 판정                          | 확인한 특이점                                              |
| -------------------------------------- | ---------------------------- | ----------------- | ---------------------------------- | ---------------------------------------------------------- |
| `manga/src/all/comick.js`              | Comick 0.1.0                 | 이미지, 41개 언어 | 기본 호환                          | JSON API                                                   |
| `manga/src/all/mangadex.js`            | MangaDex 0.1.4               | 이미지, 45개 언어 | 기본 호환·실사용 통과              | 복수 설정, 실제 App 읽기                                   |
| `manga/src/all/mangafire.js`           | Mangafire 0.1.25             | 이미지, 7개 언어  | 기본 호환                          | `console.log` 1회는 현재 출력하지 않음                     |
| `manga/src/all/webtoons.js`            | Webtoons 0.0.45              | 이미지, 7개 언어  | 기본 호환·원본 selector 노후화     | 목록/상세 200, 회차 0개                                    |
| `manga/src/ar/oduto.js`                | Oduto 0.0.1                  | 이미지            | 기본 호환                          | 단일 작품 소스                                             |
| `manga/src/ar/teamx.js`                | TeamX 0.0.3                  | 이미지            | 기본 호환                          | HTML/설정 사용                                             |
| `manga/src/en/asurascans.js`           | Asura Scans 0.1.7            | 이미지            | 기본 호환·사이트 변경              | 고정 fixture 통과, 현재 상세 selector 실패                 |
| `manga/src/en/mangapill.js`            | Mangapill 1.0.3              | 이미지            | 기본 호환·원본 selector 노후화     | 목록 HTTP 200, 결과 0개                                    |
| `manga/src/en/manhwaz.js`              | ManhwaZ 0.1.0                | 이미지            | 기본 호환                          | HTML/필터 사용                                             |
| `manga/src/en/readcomiconline.js`      | ReadComicOnline 0.1.3        | 이미지            | 기본 호환                          | HTML/설정 사용                                             |
| `manga/src/en/weebcentral.js`          | Weeb Central 0.1.0           | 이미지            | 기본 호환                          | HTML/필터 사용                                             |
| `manga/src/it/mangaworld.js`           | MangaWorld 0.0.1             | 이미지            | 기본 호환                          | 내장 정규식 파서 사용                                      |
| `manga/src/ru/mangalib.js`             | Mangalib 0.0.1               | 이미지            | 기본 호환                          | JSON API/설정 사용                                         |
| `manga/src/zh/77mh.js`                 | 新新漫画 0.0.35              | 이미지            | 네트워크 정책상 부분 지원          | 외부 평문 HTTP base URL은 의도적으로 거부                  |
| `manga/src/zh/copymanga.js`            | 拷贝漫画 0.0.25              | 이미지            | AES helper 호환·현재 API 결과 변경 | 동기 AES-CBC helper 결정적 검사 통과, 목록 200/0개         |
| `manga/src/zh/dmzj.js`                 | 动漫之家 0.0.3               | 이미지            | 부분 지원                          | 일반 경로는 HTTPS, 검색 한 경로는 외부 평문 HTTP라 거부    |
| `manga/src/zh/gfmanhua.js`             | 古风漫画 0.0.1               | 이미지            | 기본 호환                          | HTML 파서 사용                                             |
| `manga/src/zh/manhuagui.js`            | 漫画柜 0.0.25                | 이미지            | 기본 호환                          | 압축 해제 코드를 원본 자체에 포함, 별도 host helper 불필요 |
| `novel/src/all/annasarchive.js`        | Annas Archive 0.0.1          | EPUB 소설         | 미지원                             | `parseEpub/parseEpubChapter`와 전체 EPUB 다운로드 필요     |
| `novel/src/ar/kolnovel.js`             | ملوك الروايات 0.0.1          | HTML 소설         | 기본 호환·본문 크기 제한           | 목록 20개, 첫 상세가 host 안전 용량 초과                   |
| `novel/src/en/novelupdates.js`         | Novel Updates 0.0.4          | HTML 소설         | 인증 전제 부분 지원                | 원본도 로그인 필요를 명시, 임의 로그인 자동화는 범위 밖    |
| `novel/src/en/webnoveltranslations.js` | Web Novel Translations 1.0.0 | HTML 소설         | 기본 호환·원본 selector 노후화     | 목록 HTTP 200, 결과 0개                                    |
| `novel/src/en/wordrain69.js`           | WordRain69 0.0.4             | HTML 소설         | 기본 호환·사이트 종료              | 고정 fixture 전체 본문 통과, 현재 도메인은 404             |

전수 검색에서 host 전용 helper 사용은 `cryptoHandler` 1개와 EPUB helper 1개뿐이었다.
XPath, host `unpack`, Android WebView 메시지 API 사용 파일은 없었다. 77mh와 Manhuagui의 해제 코드는
원본 안에 들어 있다. 따라서 사용 증거가 없는 helper는 선제 구현하지 않는다.

## 최소 실사이트 검사

각 판정은 원본 JS를 수정하지 않고 격리 QuickJS/HTTP 경로로 실행했다. 본문·이미지 바이트는
문서나 로그에 저장하지 않았다. 사이트가 바뀌면 결과도 바뀔 수 있다.

| 소스                   | 실제 경로                        | 결과                                                            | 분류                           |
| ---------------------- | -------------------------------- | --------------------------------------------------------------- | ------------------------------ |
| MangaDex               | 검색 → 상세 → 회차 → 페이지 목록 | `The Greatest Estate Developer`, 회차 3개, 선택 회차 이미지 3개 | 성공                           |
| Webtoons               | 인기 목록 → 상세                 | 목록 159개와 상세 HTTP 200, 모바일 회차 selector 결과 0개       | 원본 selector 노후화           |
| Mangapill              | 최신 목록                        | HTTP 200, 목록 0개                                              | 원본 selector/사이트 응답 변경 |
| Web Novel Translations | 인기 목록                        | HTTP 200, 목록 0개                                              | 원본 selector/사이트 응답 변경 |
| KolNovel               | 인기 목록 → 상세                 | 목록 20개, 첫 상세 응답이 안전 용량 한도 초과                   | host 안전 한도                 |
| CopyManga              | 인기 JSON API                    | HTTP 200, 목록 0개                                              | 원본 API schema/응답 변경      |

MangaDex는 추가로 production App bundle과 임시 PostgreSQL/확장 저장소를 사용해 실제 UI에서
원본 파일 설치 → 한국어 원작 필터 저장 → 실사이트 검색·상세 → 공개 3페이지 회차 다운로드 →
390px 만화 뷰어 이미지 디코딩까지 통과했다. 확장 transport 요청은 15회였고 운영 DB·컨테이너·계정은
사용하지 않았다. 명령은 `pnpm check:extension-mangayomi-live`이며 실사이트 상태에 의존하므로 CI에는 넣지 않는다.

## 구현·제외 결정

- `cryptoHandler`는 Mangayomi와 같은 UTF-8 key/IV, AES-CBC, PKCS7, base64 계약으로 구현했다.
  QuickJS Mangayomi profile에만 동기 함수로 주입하고 입력은 4 MiB로 제한한다. 실패 시 원문을 반환한다.
- Anna’s Archive의 EPUB은 단순 helper 하나가 아니라 원격 파일 다운로드, ZIP/EPUB 파싱,
  장별 자산 수명과 저장 모델이 필요하다. 현재 공개 범위에서는 명시적 미지원으로 남긴다.
- 외부 평문 HTTP 허용, 인증서 우회, 임의 로그인 자동화, 사이트별 selector 수정은 호환 host가 대신하지 않는다.
- 실사이트 실패가 공통 API 부족을 증명하지 않으면 Moya에 사이트별 예외를 추가하지 않는다.
