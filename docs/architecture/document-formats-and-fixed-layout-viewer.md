# 문서 형식과 고정 레이아웃 뷰어

Status: implemented v1

Last verified: 2026-08-27

이 문서는 모야의 파일 형식별 import, 저장, 읽기 UI와 아직 지원하지 않는 범위를 정리한다.
텍스트 계열과 고정 레이아웃 계열은 같은 책장·진행 위치·백업 경계를 사용하지만, 읽기 화면은 서로 다른
renderer를 사용한다.

## 2026-08-27 ZIP 문서 묶음 가져오기

- 바깥 `.zip` 하나에 들어 있는 TXT/Markdown 문서 묶음 또는 EPUB 묶음을 일반 파일 선택과 `회차 추가`에서
  가져올 수 있다. 압축을 탐색하는 것만으로 작품을 여러 권 만들지 않고, 기존 document-series 계획을 거쳐
  하나의 작품과 회차 목록으로 저장한다.
- 바깥 ZIP 이름을 작품명 fallback으로 사용하고 내부 상대 경로는 자연순으로 정렬한다. 원본 문서는
  `*.moya.zip` source package 안에 그대로 보존되며 중복·충돌·실패 시 기존 작품을 보존하는 경계도 직접
  선택한 문서와 같다.
- 문서 512개, 개별 512 MiB, 전체 1 GiB와 압축률 250배 한도를 적용한다. 절대/상위 경로와 중복 경로를
  거부하고 암호 ZIP은 기존 archive password 입력을 사용한다. 이미지 archive의 단일 README는 문서 묶음으로
  오인하지 않는다.
- EPUB과 TXT/Markdown이 한 ZIP에 섞이면 작품의 최종 형식과 EPUB asset semantics가 모호하므로 자동 병합하지
  않고 형식별 ZIP으로 분리하도록 안내한다. RAR/7z 안의 문서 묶음과 재귀 압축은 이번 범위에 포함하지 않는다.

## 2026-08-26 로컬 회차 추가와 저장 경계

- TXT, Markdown과 EPUB 모두 기존 작품에 회차를 추가하는 제품 흐름을 제공한다. 가져온 원본은 계속 하나의
  작품 source archive로 갱신되고 Reader에는 통합된 회차 목록으로 보인다.
- TXT/Markdown은 기존 회차 prefix의 index, ID, title, text hash와 count가 모두 같을 때 신규 회차의 chapter,
  paragraph page, ref와 search row만 `append_delta`로 저장한다. 기존 회차의 ID가 유지되므로 읽기 위치를 다시
  매핑하지 않으며 실패·취소 시 이전 active revision과 source archive를 유지한다.
- EPUB 회차 추가 기능은 동일하지만 현재 저장은 전체 revision 교체다. EPUB paragraph의 image asset, inline
  semantics와 source locator를 포함하는 구조 fingerprint가 아직 없으므로 chapter text hash만으로 기존 회차를
  재사용하지 않는다. 이는 기능 제한이 아니라 잘못된 삽화 연결을 피하기 위한 성능 fallback이다.
- 일반 local import는 16-page IndexedDB batch, staging count 누적, chapter-only domain head와 page-canonical
  revision body를 사용한다. Document-series append도 저장 단계는 신규 회차 크기에 비례하지만, 현재 archive 생성과 parser는
  기존 source를 다시 읽는다. 전체 회차 수와 무관한 완전한 append pipeline은 후속 최적화다.

## 지원 형식

| 형식                | import        | 읽기 화면             | 현재 제공하는 기능                                                                |
| ------------------- | ------------- | --------------------- | --------------------------------------------------------------------------------- |
| TXT / Markdown      | local, Hosted | reflowable Reader     | 화 분리, 검색, 주석, 통계, TTS, page/scroll 조판                                  |
| EPUB 2/3 reflowable | local, Hosted | reflowable Reader     | 목차, semantic block, 내장 이미지·표지, 검색, 주석, 통계, TTS, page/scroll 조판   |
| PDF                 | local, Hosted | fixed-document viewer | 원본 보존, 페이지 이동, 확대/축소, 페이지/너비 맞춤, 회전, 진행 위치              |
| 이미지 ZIP / CBZ    | local, Hosted | fixed-document viewer | 자연순 페이지 정렬, 첫 이미지 표지, 페이지 이동, 확대/축소, 맞춤, 회전, 진행 위치 |

EPUB은 이번 작업에서 새로 만든 기능이 아니다. 기존 `packages/epub-core`와 공통 Reader 경로를 유지하고
회귀 테스트를 추가했다. 새 기능의 중심은 PDF와 이미지 ZIP/CBZ다.

### EPUB 삽화 처리 경계

- spine XHTML의 로컬 `<img>`와 SVG wrapper 안의 `<image>`가 참조하는 JPEG/PNG/GIF/WebP를 찾는다. 이미지가
  `<p>`, heading, list item 또는 blockquote 안에 감싸진 일반적인 EPUB2 구조도 별도 image block으로 보존한다.
- 외부 URL과 본문에서 사용하지 않는 manifest 이미지는 가져오지 않으며 OPF `cover-image`는 별도로 보존한다.
- 각 삽화는 `epub_resource` asset으로 저장되고 image paragraph의 `assetId`가 이를 가리킨다. Local은
  IndexedDB, Hosted는 S3/MinIO object와 PostgreSQL `book_assets.byte_length bigint`를 사용한다.
- Reader는 asset을 필요할 때 Blob URL로 열어 본문 위치에 렌더링하고 화면에서 사라지면 URL을 해제한다.
- Scroll/page mode 모두 삽화의 intrinsic size와 비율을 유지하고 reader content width와 70vh/56rem을 공통
  ceiling으로 사용한다. Page mode는 실제 stage height를 넘을 때만 추가 축소하고 chapter heading이 함께 있는
  첫 page는 heading/margin 공간을 예약한다. 조판 measurement placeholder도 같은 ceiling을 사용한다.
- 현재 EPUB 안전 한도는 entry 4,000개, 개별 해제 파일 32 MiB, 전체 해제 크기 128 MiB, 압축률 250배다.
  서버의 원본 upload 기본 한도 500 MiB와는 별도이며, 이 범위를 넘는 image-heavy EPUB은 archive bomb과
  저메모리 기기 보호를 위해 명시적으로 거부한다.
- SVG 자체가 vector 삽화인 경우와 AVIF는 아직 보존하지 않는다. SVG를 추가할 때는 script/external reference
  sanitization을 먼저 두고, 128 MiB보다 큰 EPUB은 모든 이미지를 동시에 materialize하지 않는 streaming
  asset ingestion으로 확장한다.
- 표지는 EPUB3 manifest의 `cover-image`, EPUB2 `<meta name="cover">`, OPF guide의 cover document 순으로 찾고,
  선언이 없는 legacy 파일만 `cover*` image 관례를 보수적으로 사용한다. cover document가 XHTML/SVG wrapper면
  그 안의 첫 로컬 image manifest item을 실제 표지 asset으로 저장한다.
- Hosted 대형 파일은 2 MiB resumable chunk를 사용한다. Worker는 eager EPUB image asset을 4개씩 저장하고,
  object-storage bucket readiness와 orphan reservation을 asset마다 반복하지 않는다. 원본 archive 보존,
  streaming archive page path와 import transaction 경계는 유지한다.

2026-08-21에는 EPUB normalized-text hash의 마지막 8 hex를 그대로 cover seed로 사용해 PostgreSQL signed
`integer` 최대값을 넘을 수 있던 Hosted import 오류를 수정했다. EPUB core가 처음부터 31-bit 양수 범위의
결정적 seed를 만들고 server persistence 경계도 같은 범위로 정규화한다. 이 오류는 삽화 byte length가 아니라
표지 색상용 seed에서 발생했으며, 별도 256 KiB 삽화와 표지를 함께 보존하고 image block을 asset에 연결하는
회귀 fixture로 경로를 확인한다.

같은 날 실제 EPUB2 두 권을 점검해, Novelpia Dumper 계열의 `<p><img .../></p>` 삽화가 paragraph의 조기 반환에
가려지던 문제를 수정했다. 약 8.5 MiB 표본의 표지 1장/삽화 1장과 약 20.2 MiB 표본의 표지 1장/삽화 12장이
모두 manifest resource, image block과 cover asset으로 연결되는 것을 원본 파일로 확인했다. 원본 파일은
fixture나 저장소에 포함하지 않는다.

EPUB2 본문은 XHTML 1.1 DTD를 선언하면서 XML 기본 entity가 아닌 `&nbsp;`, `&copy;` 등을 사용하는 경우가
흔하다. container/OPF/NCX와 archive path는 계속 strict XML·안전 검사를 적용하되, spine 본문·EPUB3 nav·cover
document만 strict parse 실패 시 local HTML parser로 복구한다. 이 fallback은 외부 DTD나 URL을 fetch하지 않으며
기존 script/form/iframe 및 remote image 제외 정책을 그대로 통과한다. UTF-8 외에는 BOM이 명시된 UTF-16LE/BE를
지원하고 manifest media type의 대소문자와 `charset` parameter를 정규화한다.

2026-08-21 실제 약 1.0 MiB EPUB2에서 128개 본문 파일의 `&nbsp;` 948개 때문에 첫 화가 손상 XML로 오인되던
문제를 이 경계로 수정했다. 전체 128화/29,990개 paragraph, 표지 포함 resource 2개와 image block 2개를 끝까지
materialize했다. 같은 parser로 앞선 약 8.5 MiB/20.2 MiB 실제 EPUB도 각각 282화/274화, 모든 본문·표지와
1개/12개 삽화를 다시 확인했다.

## 구현 경계

- `packages/fixed-document-core/`: PDF metadata/page-count 검사, 이미지 ZIP 안전 검사와
  `ParsedNovelImport` materialization을 담당한다.
- `src/services/import/browser-import-pipeline.ts`: local Web Worker import를 형식별 parser로 dispatch한다.
- `apps/server/src/services/import-service.ts`: Hosted upload worker가 같은 core package를 사용한다.
- `src/features/fixed-document/`: PDF.js canvas 또는 저장된 이미지 asset을 표시하는 전용 fixed-document
  screen이다. 텍스트 Reader의 조용한 화면과 분리해 어두운 상용 문서 뷰어 문법을 사용한다.
- `BookAssetRepository`: PDF는 원본 source를, 이미지 ZIP/CBZ는 원본·페이지 asset·첫 페이지 cover를 보존한다.
- PostgreSQL `0027_fixed_documents.sql`: `pdf`, `image_archive`, `document_page`와 page index를 Hosted 저장소에
  추가한다.

페이지 하나를 chapter 하나로 투영해 기존 reading-position, library progress와 sync 계약을 재사용한다.
원본 PDF/ZIP은 다시 인코딩하거나 재작성하지 않는다. Local ZIP/CBZ는 원본 `File`/`Blob`을 청크 해시하고
central directory를 먼저 검증한 뒤 page entry 하나씩 signature/hash 검사와 IndexedDB staging을 수행한다.
모든 페이지가 성공하기 전에는 새 revision을 활성화하지 않고, 중간 실패·취소 시 이미 stage된 asset도
정리한다. 이미지 ZIP/CBZ의 각 페이지는 원본 byte hash와
archive 내부 경로를 유지한다.

## 고정 레이아웃 UX

Desktop/넓은 화면에서는 제목, 페이지 목록, 현재 페이지 입력, 단일/연속 보기, 확대/축소, 페이지/너비
맞춤, 90도 회전, 이전/다음 이동과 하단 진행률을 제공한다. 키보드 방향키, Page Up/Down과 Space도 페이지를
이동한다.

이미지 archive의 `세로 연속`은 기존 페이지 여백과 그림자를 유지한다. `경계 없는 세로 연속`은 같은
virtualized page window와 현재 위치 추적을 재사용하되 virtualizer gap, article padding, page shadow와
비현재 페이지 흐림을 제거한다. 이미지 load 뒤 실제 article 높이를 다시 측정하므로 desktop과 mobile 모두
인접 페이지가 0px 간격으로 맞닿는다. 화면 맞춤과 crop/색 보정은 별도 설정으로 그대로 적용된다.

720px 이하에서는 페이지 sidebar, 연속 보기와 부가 control을 감추고 제목, 확대/축소, 페이지 맞춤,
현재 페이지와 진행도만 남긴다. 좌우 swipe로 페이지를 넘긴다. 이는 Android에 별도 UI를 복제하지 않고
같은 React viewer를 쓰기 위한 mobile 기준이다.

## 안전 경계

이미지 ZIP/CBZ import는 다음을 거부한다.

- 절대 경로, `..` traversal, 중복 경로와 잘못된 percent encoding
- 암호화 archive
- 확장자와 실제 JPG/PNG/WebP/GIF signature가 다른 entry
- 6,000개 초과 entry, 5,000페이지 초과 문서
- 페이지당 64MiB, 전체 해제 1GiB 또는 압축률 250배를 넘는 archive

PDF도 1~5,000페이지 범위만 받는다. PDF.js와 이미지 page cache는 lazy load하며 화면에서 멀어진 항목을
정리한다.

## 백업과 플랫폼

- Local exact backup은 기존 `book_assets` 순회로 source, cover와 `document_page`를 보존한다.
- Hosted backup/restore는 active `document_page` object를 포함하고 copy/replace 시 book/asset ID를 다시 연결한다.
- Android SAF picker allowlist에는 PDF, ZIP, CBZ MIME과 확장자가 연결됐다. 실제 content URI import 완료와
  큰 문서 메모리 동작은 물리 기기에서 아직 검증하지 않았다.

## 의도적으로 남긴 범위

고정 레이아웃 v1 이후 PDF text/OCR/검색/주석/TTS와 comic layout/archive 형식 기반은 구현됐다. 다음 범위와
실기기·실문서 증거는 아직 완료로 보지 않는다.

- tagged PDF logical order/role의 실문서 증거, vertical/RTL PDF 구조 해석, 실문서 OCR 품질과 app-closed OCR
  scheduling/model storage 관리
- 암호화 PDF/RAR4와 HTTP Range archive, RAR/7z random-access source (암호화 RAR5/7z까지 page output은 stream
  stage지만 RAR/7z 암호 재시와 source open은 local whole-buffer 기반)
- ZIP/CBZ 1,000+ page peak heap과 Android SAF 취소/재시작 practical evidence
- 두 페이지 spread, 우→좌, crop/색 보정의 저사양 Android 실기기 검증
- PDF 첫 페이지 thumbnail을 책장 cover asset으로 추출하는 기능
- 수천 페이지 sidebar virtualization과 저사양 Android 대용량 실기기 측정
- live PostgreSQL/S3에서 PDF·CBZ import/backup/restore round-trip

이 항목들은 reflowable Reader 기능을 억지로 고정 문서에 노출하기보다 별도 후속 slice로 구현한다.

위 후속 범위의 source range, virtual page layout, PDF text/OCR/annotation/TTS, comic spread와 RAR/7z 구현
순서는 [Document & Listening v2 구현 계획](../project/document-listening-v2/README.md)을 따른다.

## 2026-08-01 foundation update

CP1 adds `BookAssetRepository.openSource()` as the fixed-viewer byte boundary. Local sources use `Blob.slice()`;
Hosted sources issue authenticated single-range requests and the server passes the range to object storage. The page,
text-revision and annotation contracts/stores are additive foundations only; PDF text extraction and virtual rendering
remain in CP6-CP9.

## 2026-08-01 EPUB semantic update

Reflowable EPUB import now treats ruby annotation as metadata rather than flattened body text: base text remains in
`Paragraph.text`, `rt/rp` is excluded, and ruby reading, `lang/xml:lang` and `epub:type=noteref` survive as additive
inline semantics. The Reader renders native ruby/lang markup and internal links retain exact fragments through
materialization, including targets beyond paragraph page zero. TTS uses ruby readings and skips note markers by
default without changing search/copy source. Footnote popover/bottom-sheet presentation and mixed-language voice
splitting remain follow-up UX; current internal links navigate to the exact note block.

## 2026-08-01 PDF OCR revision lifecycle update

Local OCR uses the existing document-text revision store rather than mutating PDF source or Reader paragraphs. A
deterministic pending revision is written before page raster/provider execution; ready activation remains atomic and
failure/cancellation stays bounded on the operation revision. On PDF re-entry, abandoned pending work becomes failed
and retryable unless a matching ready page already exists, in which case only the obsolete operation is marked stale.
This does not claim background execution or explicit Tesseract model management.

## 2026-08-01 comic crop batch update

Whole-book auto-crop reuses the guarded downscaled detector through a sequential runner. It opens and closes one page
bitmap at a time, reports progress, supports cancellation and continues after per-page failure. Successful normalized
margins merge into the local comic profile in one save; source images and prior successful margins are preserved.
Content-box-aware re-fit and background crop caching are still separate follow-ups.

## 2026-08-01 comic crop re-fit update

Normalized margins now produce a display-only scale against the active fit axis: width uses visible content width,
height uses visible content height, page uses the stricter axis and original keeps pixel scale unchanged. The stored
page/width/height/original profile is restored and selectable. Source assets, crop evidence and page geometry remain
unchanged; physical aspect-ratio/touch validation and background crop caching remain open.

## 2026-08-01 ComicInfo page layout update

Page-level ComicInfo metadata stays attached to materialized page paragraphs and is restored lazily at the existing
visible-page boundary. The pure spread planner treats `DoublePageSize` as a standalone full-width page and prevents
pairing across it while preserving cover, parity, LTR/RTL order and logical page progress. Page types are informative:
the rail labels common values, but even `Deleted` does not hide source bytes without an explicit user policy.

## 2026-08-01 PDF multi-block text anchor update

Same-page PDF selection now projects DOM endpoints into ordered block ranges. `fixed_text` keeps its legacy first-block
fields and normalized quads, while optional `blockRanges` records exact offsets for every selected block. This permits
multi-block copy/highlight/note without rewriting derived text or source PDF and keeps older quad-based rendering usable.
Cross-page ranges remain separate work.

## 2026-08-01 PDF annotation revision remap update

Fixed-text annotations now carry optional remap provenance independent from their canonical anchor. When native or OCR
text activation changes the page revision, a pure matcher accepts only a unique exact quote in target reading order and
rebuilds block ranges/quads. Missing or ambiguous evidence preserves the previous anchor and records `needs_review`;
automatic deletion and best-guess movement are forbidden. Page/region annotations do not depend on text revisions.
Cross-page anchors and remote merge semantics remain follow-up work.

## 2026-08-01 PDF reading-order override update

Automatic line/two-column ordering remains immutable derived data. A page-level user override stores only ordered and
excluded source fingerprints in IndexedDB v32, where each fingerprint combines normalized text, block role/direction
and rounded canonical quads. Repository reads project the override into display/search/TTS, append unmatched blocks in
automatic order and omit only explicit exclusions. Annotation remap and OCR quality gates intentionally use raw blocks.

The viewer exposes preview, up/down movement, include/exclude, apply and reset in the existing PDF sheet. Local exact
backup and encrypted Cloud Vault include the override. Cloud Vault maps source-hash/page stable ids back to the local
book id and carries reset tombstones. A new native/OCR revision reuses only matching fingerprints; it never guesses by
page position alone or mutates the PDF/text revision. Hosted event sync remains separate work.

## 2026-08-01 PDF generated-cover update

The local book-asset repository exposes an optional derived-cover write. A PDF with no active cover renders page one to
a bounded JPEG and keys the preview by source hash, page hash, renderer version and target size. The storage transaction
checks active cover provenance again, so it may replace only `generated_preview`; user-supplied, EPUB and archive covers
always win. Novel metadata points at the local derived asset without emitting a user `book_updated` mutation. Exact
backup follows the existing generic asset path.

Hosted PDF uses the same client renderer over the authenticated Range source. `RemoteBookAssetRepository` marks the
upload as `generated_preview`; the server locks the book and current cover asset before replacement and refuses an
authored-cover race. Identical generated content is idempotent. The PDF source never enters the cover PUT and no
server-side PDF renderer is introduced.

## 2026-08-01 persistent document thumbnail update

Visible virtual-rail PDF pages render canonical low-resolution JPEGs behind an abortable PDF.js task. IndexedDB v33
stores the Blob with page hash and renderer fingerprint; a mismatch deletes the stale row instead of displaying it.
Access time drives a 5,000-page or 64MiB per-book fence. This cache is derived and rebuildable: book deletion removes it,
while exact backup, sync and Cloud Vault exclude it. The virtual rail can explicitly prepare a whole PDF, skipping exact
cache hits, rendering one page at a time, continuing past isolated failures and cancelling the active PDF.js render.
ZIP/CBZ/CBR/CB7 rail rows use the same cache with a separate renderer fingerprint and a page identity derived from the
archive source and embedded asset. Cache hits happen before full image reads/decodes. The rail window no longer expands
the full-resolution object-URL working set; original images are requested for displayed pages plus a two-page turn
buffer and remain under the existing 20-item cap. Physical large-document duration/quota/low-memory evidence remains
open.

The explicit preparation runner is format-neutral. PDF and ZIP/CBZ/CBR/CB7 expose the same progress/cancel action and
preserve completed thumbnails after cancellation or isolated page failure. For archives, each iteration resolves a
lightweight paragraph asset identity, checks the persistent cache, and reads/decodes one full image only on a miss.

## 2026-08-01 OCR language cache ownership update

Tesseract.js owns its browser language payloads in the default `idb-keyval` database rather than Moya's reader
database. The PDF search surface now inspects only the exact Korean, Japanese and English trained-data keys, reports
their stored byte sizes, and can delete one language after terminating the live OCR worker. It deliberately does not
delete the shared database or enumerate/delete unrelated keys.

These payloads are rebuildable runtime cache, not user data: exact backup, sync and Cloud Vault exclude them. Language
selection still drives lazy download through the OCR provider boundary; UI components do not fetch a model URL or call
an OCR service directly. Physical offline reload, browser quota eviction and packaged desktop/Android cache behavior
remain verification work.

## 2026-08-01 low-confidence OCR listening update

The fixed-document listening queue applies the same 0.45 quality threshold used to classify OCR candidates. A latest
ready OCR page below that threshold is skipped by normal playback, previous/next traversal and offline audio warmup;
native PDF text is not filtered. This is a TTS projection fence only: the derived revision remains available for
search, copy, annotation and user inspection, and the source PDF is untouched. Starting from an explicitly selected
rejected block stops with a re-OCR message rather than silently advancing.

## 2026-08-26 local serialized image-archive import

Local comics can now enter the same logical work → release → page model as connected Suwayomi works. The importer
accepts either separately selected ZIP/CBZ/RAR/CBR/7z release archives or one outer ZIP/CBZ whose immediate children
are ZIP/CBZ release archives. It deliberately rejects recursive nesting and a container that mixes direct images with
child archives instead of guessing which structure the user intended.

`serial-release-name.ts` extracts conservative work and release identities from common Korean, Japanese and English
forms such as `12화`, `제12화`, `3권`, `第2巻 第12話`, `Chapter 12`, `v01 c012` and `S02E03`. A bare number is accepted
only with parent-title evidence. Ambiguous names such as years, version suffixes and unmatched numeric titles stay a
single ordinary archive; loose normalization exists for later metadata search but never triggers an automatic merge.

The import dialog shows the inferred title and every proposed release before writing. An exact normalized-title match
may be selected as the append target, and a serialized-work detail offers an explicit `로컬 회차 추가` action. Exact
content hashes are skipped. A matching release identity with different bytes is reported as a conflict and preserves
the existing release. New pages are assembled by the format-neutral `series-image-archive` service, which is also used
by the Suwayomi adapter, then committed through the existing same-book atomic content-revision boundary.

The aggregate still uses `moya-series.json` for compatibility. This checkpoint does not inspect nested RAR/7z outer
containers, auto-merge already separate Library works, replace a conflicting release, or fetch metadata/covers. Those
remain explicit follow-ups rather than filename-driven destructive behavior.

## 2026-08-26 local TXT and EPUB chapter append

Chapter append is a local Library capability rather than a Suwayomi-specific action. TXT/Markdown and EPUB works now
expose `회차 추가` from their normal work detail. An ordinary single image archive also enters the local serialized
detail as its first release, so it can be promoted without first originating from an external source.

Text and EPUB sources cannot use the image aggregate. The shared `document-series-core` package therefore stores each
original file byte-for-byte in a bounded `*.moya.zip` package together with a manifest that records its format,
content hash, parser settings and the exact source chapter indices accepted into the work. Browser and Hosted import
both detect this manifest before treating a ZIP as an image archive, materialize every source through the existing
TXT/Markdown or EPUB parser, and commit one ordinary `txt`, `markdown` or `epub` Novel through the same atomic content
revision boundary.

Incoming normalized chapter titles and text hashes are compared before package construction. An exact title+content
identity is skipped; an equal normalized chapter title with different content is a conflict and keeps the existing chapter. Existing legacy TXT splitting must
be reproducible under its supported parser modes before promotion, otherwise append fails closed. EPUB embedded
resources, source semantics and every retained source file remain available; stable source-scoped chapter and
paragraph IDs preserve existing anchors when later sources are appended.

This does not silently combine different format families, merge already independent Library records, or replace a
conflicting chapter. Filename extraction proposes a work identity and ordering, but an explicit work-detail action or
confirmed exact-title target remains the authority to append.
