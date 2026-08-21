# 문서 형식과 고정 레이아웃 뷰어

Status: implemented v1

Last verified: 2026-08-21

이 문서는 모야의 파일 형식별 import, 저장, 읽기 UI와 아직 지원하지 않는 범위를 정리한다.
텍스트 계열과 고정 레이아웃 계열은 같은 책장·진행 위치·백업 경계를 사용하지만, 읽기 화면은 서로 다른
renderer를 사용한다.

## 지원 형식

| 형식                | import        | 읽기 화면             | 현재 제공하는 기능                                                                |
| ------------------- | ------------- | --------------------- | --------------------------------------------------------------------------------- |
| TXT / Markdown      | local, Hosted | reflowable Reader     | 화 분리, 검색, 주석, 통계, TTS, page/scroll 조판                                  |
| EPUB 2/3 reflowable | local, Hosted | reflowable Reader     | 목차, semantic block, 내장 이미지·표지, 검색, 주석, 통계, TTS, page/scroll 조판   |
| PDF                 | local, Hosted | fixed-document viewer | 원본 보존, 페이지 이동, 확대/축소, 페이지/너비 맞춤, 회전, 진행 위치              |
| 이미지 ZIP / CBZ    | local, Hosted | fixed-document viewer | 자연순 페이지 정렬, 첫 이미지 표지, 페이지 이동, 확대/축소, 맞춤, 회전, 진행 위치 |

EPUB은 이번 작업에서 새로 만든 기능이 아니다. 기존 `packages/epub-core`와 공통 Reader 경로를 유지하고
회귀 테스트를 추가했다. 새 기능의 중심은 PDF와 이미지 ZIP/CBZ다.

### EPUB 삽화와 표지 처리 경계

- spine XHTML의 로컬 `<img>`와 SVG wrapper 안의 `<image>`가 참조하는 JPEG/PNG/GIF/WebP를 찾는다.
- 외부 URL과 본문에서 사용하지 않는 manifest 이미지는 가져오지 않는다.
- 각 삽화는 `epub_resource` asset으로 저장되고 image paragraph의 `assetId`가 이를 가리킨다. Local은
  IndexedDB, Hosted는 S3/MinIO object와 PostgreSQL `book_assets.byte_length bigint`를 사용한다.
- 표지는 EPUB3 manifest의 `cover-image`, EPUB2 `<meta name="cover">`, OPF guide의 cover document 순으로 찾고,
  선언이 없는 legacy 파일만 `cover*` image 관례를 보수적으로 사용한다. cover document가 XHTML/SVG wrapper면
  그 안의 첫 로컬 image manifest item을 실제 표지 asset으로 저장한다.
- Reader는 asset을 필요할 때 Blob URL로 열어 본문 위치에 렌더링하고 화면에서 사라지면 URL을 해제한다.
- 현재 EPUB 안전 한도는 entry 4,000개, 개별 해제 파일 32 MiB, 전체 해제 크기 128 MiB, 압축률 250배다.
  서버의 원본 upload 기본 한도 500 MiB와는 별도다.
- Hosted 대형 파일은 2 MiB resumable chunk를 사용한다. Worker는 eager EPUB image asset을 4개씩 저장하고,
  object-storage bucket readiness와 orphan reservation을 asset마다 반복하지 않는다. 원본 archive 보존과
  import transaction 경계는 유지한다.
- SVG 자체가 vector 삽화인 경우와 AVIF, 128 MiB보다 큰 streaming EPUB asset ingestion은 아직 지원하지 않는다.

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

source range, virtual page layout, PDF text/OCR/annotation/TTS, comic spread와 RAR/7z 구현은 아래 현재 구조와
각 기능 source/test 경계를 기준으로 유지한다.

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
