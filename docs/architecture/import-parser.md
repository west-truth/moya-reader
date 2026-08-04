# Import와 Parser

Status: current
Last verified: 2026-08-01

PDF와 이미지 ZIP/CBZ를 포함한 전체 형식 매트릭스와 fixed-layout 경계는
[문서 형식과 고정 레이아웃 뷰어](document-formats-and-fixed-layout-viewer.md)를 따른다. 이 문서의 아래 내용은
TXT/Markdown parser를 중심으로 설명한다. EPUB은 `packages/epub-core`, PDF/이미지 archive는
`packages/fixed-document-core`가 담당한다.

## 위치

- `src/domain/parser.ts`
- `src/test/parser.test.ts`

## Import Flow

현재 browser import는 `BrowserImportService`가 `File`을 module Web Worker에 넘기고, worker가 전체 파일을 읽은 뒤 parser와 IndexedDB 저장을 실행한다.

```text
Import modal file selection
  -> chapter-split-preview-worker can read/parse the selected file without saving
  -> previewNovelChapterSplit(file.name, buffer, encoding, chapterSplitMode)
  -> UI shows detected encoding, chapter count, paragraph count, and first chapter titles

BrowserImportService
  -> import-worker receives File
  -> worker reads File in bounded chunks with reading progress/cancel checks
  -> parseNovelFileForImport(file.name, buffer, encoding, chapterSplitMode)
  -> decodeNovelTextWithEncoding()
  -> normalizeNovelText()
  -> splitChapters()
  -> import-ready chapter source
  -> worker saveParsedNovelImport() batch page write
  -> UI receives novel metadata
```

The parser and IndexedDB write now run in Web Workers for browser import flows. The preview worker reads the selected file and returns chapter split metadata without saving, so users can switch split modes before starting the real import. The import worker reads the `File` in bounded chunks, reports byte-level reading progress, and checks cancellation at chunk boundaries before parsing. IndexedDB save writes chapter/page data in page batches and reports persisted paragraph progress. Cancel requests are delivered to the worker, and imports cancelled during reading or page writes are rolled back so partial chapter/page rows do not remain in the local library; replacement imports restore the previous local content snapshot. This removes parser/storage work from the React UI path. Parsing is still a whole-file worker-buffered import, but the worker releases the raw input `ArrayBuffer` after hashing/decoding and before import-ready normalization/splitting, the import-ready path releases the decoded raw string after normalization, no longer hands storage a full `ParsedNovel.paragraphs` array, stores chapter body ranges instead of keeping every chapter body string, counts paragraphs from source ranges, and consumes long chapters as range-based paragraph iterables while page batches are written. Chapter heading collection scans lines from the normalized string instead of building a full `text.split('\n')` line array.

## Encoding

지원:

- `auto`
- `utf-8`
- `euc-kr`

`auto`는 먼저 fatal UTF-8 decode를 시도한다. 성공하면 UTF-8로 확정하고, 실패하면 EUC-KR decoder와 replacement character 수를 비교해 CP949/EUC-KR fallback을 선택한다. `parseNovelFile()`은 사용자가 `auto`를 골랐더라도 `Novel.sourceEncoding`에 실제 감지 결과인 `utf-8` 또는 `euc-kr`를 저장한다.

검증:

- UTF-8 fixture 자동 감지.
- CP949 byte fixture 자동 감지.
- CP949/EUC-KR 수동 선택.

한계:

- UTF-8과 CP949/EUC-KR 외의 legacy encoding은 지원하지 않는다.

## Normalization

`normalizeNovelText()` 처리:

- BOM 제거.
- CRLF/CR을 LF로 통일.
- tab을 space 2개로 변환.
- line trailing space 제거.
- 4개 이상 연속 newline을 3개로 압축.
- 전체 trim.

## Chapter Detection

Import UI exposes three chapter split modes for local imports and hosted server imports:

- `auto`: default conservative automatic split.
- `mixed`: accepts mixed weak heading styles when numbering continuity and body-length guards support it. Use this when a file changes producer/export format midway, for example `00001 ...` followed later by `002 - title`, or an explicit `제 1화`/`Chapter 1` sequence ends with a trailing compact form such as `2. title` or `[002]`.
- `single`: disables chapter splitting and stores the full file as one chapter named from the file title.

Local and hosted remote import can preview split results in the browser worker before saving. Hosted remote import sends the selected split mode to the server upload session and applies it during worker parsing.

strong heading:

- `제 12화`, `제 십이화`
- `1화`, `2장`, `001화`
- `[제 12화]`, `[1화]`, `【제1화】`
- `Chapter 4`, `Chap. 7`, `Chapter IV`, `[Chapter 004]`, `EP. 004`, `Episode #12`
- `#4 - 제목`
- `프롤로그`, `에필로그`, `외전`, `작가 후기`
- `<1화>`, `<프롤로그 : 제목>`
- `第1화`, `第十二章`, `[第十話]`, `１２화`
- `{제3화}`

weak heading:

- `00001 <-- 작품명 -->`
- `[1]`
- `[001] Title`
- `【001】`, `『002』`
- `{1}`
- `40_Title`
- `52 Lack of time`, `05 부제`
- `001 - 제목`
- `{001 - 제목}`, `(001 - 제목)`, `001: 제목`
- `- 001 - 제목`, `E01 제목`
- `1. 제목`
- `001`
- `Novel Title 1화`

weak heading은 단독으로 인정하지 않는다. blank-line isolation, 증가하는 숫자 sequence, 2개 이상 run, 각 heading 뒤 최소 본문 길이 조건을 만족해야 한다. `52 Lack of time`처럼 구분자 없이 숫자와 부제로 구성된 줄도 `number_title` weak family이며, 인접한 숫자-only/제목형 sequence가 anchor가 될 때만 채택한다. 다만 `001 - title`, `[001] Title`, `1. title`처럼 제목 신호가 있는 weak heading은 본문이 바로 다음 줄에서 시작해도 후보로 인정한다. `[001]`, `001`처럼 제목이 없는 숫자-only 계열은 오탐을 줄이기 위해 heading 뒤 blank line을 계속 요구한다.

`auto` mode accepts low-risk weak family changes when the numeric run and body-length guards prove a producer/export style switch. It can also accept a later high-risk producer switch when an already accepted chapter number anchors the run, at least two new weak headings continue the sequence across different families, and one of those headings carries a title signal. This covers cases like `Chapter 1` followed by `[002]` and `3. Title` without treating a document that starts with only `[1]`/`001` style lines as chapters.

`mixed` mode keeps the same false-positive guards, but can accept weak candidates across different weak families when they form a numeric run. It can also accept a single lower-risk weak candidate when it is anchored by adjacent accepted chapter numbers. For files that clearly started with accepted chapter numbers, `mixed` also accepts one trailing high-risk weak marker when it continues the previous chapter number and has enough body text, covering final-section producer/export switches such as `제 1화` followed by `2. title` or `Chapter 1` followed by `[002]`.

## False Positive Guard

방어 대상:

- `[시스템 알림: ...]`
- `[1] 각주 내용입니다.`
- `1. 아이템을 확인한다`
- `나는 3회 연속 실패했다`
- `<시스템 알림(1)>`
- 날짜/로그처럼 보이는 줄
- 제목처럼 보이지만 명시적 화 표식이 없는 줄
- 숫자와 콜론으로 시작하지만 본문 선택지/목록처럼 보이는 짧은 줄

## Fallback

accepted heading이 없으면 파일명에서 가져온 novel title을 chapter title로 삼아 1개 chapter로 둔다. 이는 "제목만 딸랑 있는 경우 억지로 화를 만들지 않는다"는 제품 원칙이다.

## Paragraph Split

- blank-line block이 3개 이상이면 blank-line 기준으로 paragraph를 나눈다.
- 그렇지 않으면 non-empty single line 기준으로 나눈다.
- paragraph는 chapter 안의 start/end offset과 text hash를 가진다.

## Speaker attribution source preflight

AI 화자 분석은 parser 결과를 다시 분할하거나 원문을 수정하지 않는다. 현재 active content revision과 승인된
수동 화 구조에서 `SpeakerSourceManifestV1`을 만들고 normalized source hash, chapter ID/index/range/body hash,
empty chapter와 optional expected chapter count를 먼저 검사한다. 예를 들어 expected 90과 accepted 73이 다르면
silent success가 아니라 `review_required`다. 해소는 기존 수동 화 split/merge/range-reparse를 사용한다.

Manifest가 유효하면 paragraph source anchor에서 deterministic scene/span/dialogue-burst inventory를 만든다.
offset은 JavaScript UTF-16 code unit이다. 균형 잡힌 단일/복수 quote와 앞뒤 narration은 확정된 offset대로
분리하고, nested/unbalanced quote만 삭제하거나 추측하지 않은 `boundaryReview` span으로 남긴다. 한 문단의
복수 dialogue는 경계 검토가 아니라 후속 화자 resolver 대상으로 보낸다. 장별 derived inventory는
parser/content revision 및 detector version과 별도 fingerprint를 가지므로 parser, detector나 수동 구조가
바뀌면 폐기 후 재생성한다.

## Known Limitations

- Import-ready storage no longer builds a complete `ParsedNovel.paragraphs`, chapter body string, or `ParagraphPage[]` before page-batch writes, but parsing still needs the complete normalized text string.

- parser는 streaming parser가 아니다.
- offset은 original file byte offset이 아니다.
- 파일 읽기는 bounded chunk progress/cancel을 제공하지만, 매우 큰 파일에서 전체 decode/normalize/split 비용은 worker에 격리된 whole-file buffer 위에서 실행된다.
- storage write는 batch transaction으로 나뉘며 신규 import-ready path는 full `ParsedNovel.paragraphs`나 complete `ParagraphPage[]`를 먼저 만들지 않는다. 구형 compatibility parser/API는 아직 남아 있다.
- cancel cleanup은 batch 저장 경계에서 동작하므로 이미 실행 중인 synchronous parse 자체를 중간에 끊는 streaming parser는 아직 아니다.
- chapter heading heuristic은 계속 fixture 기반으로 보강해야 한다.
