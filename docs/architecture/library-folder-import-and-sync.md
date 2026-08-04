# 책장 폴더 일괄 가져오기와 변경 동기화

Status: implemented foreground baseline

Last updated: 2026-08-01

## 목적

사용자가 소설 파일이 모인 폴더를 한 번 선택하고, 지원 형식·파일 용량·하위 폴더 포함 여부를 미리 확인한
뒤 선택한 파일을 한꺼번에 책장에 넣는다. 연결을 유지하면 앱이 다시 활성화되거나 5분 foreground 주기가
도래했을 때 새 파일과 바뀐 원본을 같은 import pipeline으로 반영한다.

이 기능의 제품명은 Cloud Vault의 백업용 `동기화 폴더`와 혼동하지 않도록 **책장 폴더**로 고정한다.

## 사용자 흐름

1. Library 상단의 폴더 아이콘 또는 모바일 더보기에서 `책장 폴더`를 연다.
2. 폴더를 선택한다.
   - Browser/Tauri desktop: File System Access directory handle
   - Android: Storage Access Framework `ACTION_OPEN_DOCUMENT_TREE`
3. 형식, 최소/최대 MB, 하위 폴더 포함을 선택한다.
4. 미리보기에서 새 책, 원본 변경, 기존 책 연결, 최신, 원본 없음, 제외 파일을 구분한다.
5. 선택한 파일을 확인 후 가져온다.
6. 필요하면 `변경 자동 반영`을 켠다. 새 폴더의 기본값은 꺼짐이며 최초 미리보기를 건너뛰지 않는다.

모바일은 가로 표를 사용하지 않고 파일명·상대 경로·상태·선택만 남긴 단일 열 카드로 축약한다.

## 지원 범위

- text: TXT, Markdown
- EPUB
- PDF
- ZIP/CBZ
- RAR/CBR
- 7z/CB7
- 최소/최대 byte filter
- recursive scan on/off
- 최대 20,000개 파일의 bounded metadata scan

폴더 기능은 parser를 복제하지 않는다. 선택 파일을 기존 `ImportService`로 넘기므로 encoding, EPUB/PDF/
archive 처리, 원본 asset, cover, content revision과 저장 실패 복구는 일반 가져오기와 같은 계약을 따른다.

## 변경 판정과 데이터 보존

빠른 foreground scan은 provider-local source key, byte length와 last-modified를 사용한다.

- 새 파일: 새 책으로 가져온다.
- 수정 파일: 저장된 `bookId`를 `clientBookId`로 전달해 같은 책의 새 content revision을 활성화한다.
- 같은 파일명인 기존 책: 미리보기에서 `기존 책에 연결`로 명시하고 확인 후 같은 `bookId`에 반영한다.
- 동일 source hash가 이미 있는 책: 중복 import 대신 기존 책과 folder entry를 연결한다.
- rename: Android document id가 유지되면 그대로 추적한다. Browser는 유일한 size/mtime/extension 조합일 때만
  기존 link를 이동하고, 모호하면 missing + new로 남긴다.
- 삭제: 책을 삭제하지 않는다. folder entry만 `missing`으로 표시한다.

수정 import는 기존 content revision activation/remap 경로를 통과하므로 독서 위치, bookmark, highlight,
note를 새 paragraph/section identity에 맞춰 보존한다. 자동 삭제 옵션은 구현하지 않았다.

## 저장소와 보안 경계

`noveldesk-library-folders` 전용 IndexedDB에는 세 store가 있다.

- `folders`: 표시 이름, filter, auto-sync, 마지막 scan/error
- `entries`: 상대 경로, provider-local key, quick signature, 연결된 local book id, missing/failed state
- `handles`: Browser `FileSystemDirectoryHandle`

Android tree URI는 Kotlin plugin의 private SharedPreferences에 random folder id로 매핑하고 persistable read
permission만 보존한다. JavaScript와 일반 sync payload에는 raw tree URI가 들어가지 않는다.

folder config, handle/URI, 상대 경로와 source mapping은 모두 **기기 로컬 상태**다. Reader backup, hosted sync,
Cloud Vault와 Dropbox payload에 포함하지 않는다. 소설 원문도 기존 정책대로 자동 cloud upload하지 않는다.

## 플랫폼 동작

| 환경                 | 선택/읽기                   | 자동 재확인                                             | 현재 한계                                         |
| -------------------- | --------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| Browser / hosted web | File System Access handle   | permission이 유지된 foreground tab에서 visibility + 5분 | 지원 브라우저만 가능, server filesystem 접근 없음 |
| Tauri desktop        | WebView directory handle    | 앱 foreground/visibility + 5분                          | native filesystem watcher는 아직 없음             |
| Android              | SAF tree URI + chunk bridge | 앱 foreground/visibility + 5분                          | WorkManager는 원본 import를 실행하지 않음         |

Android background worker가 WebView IndexedDB를 직접 수정하지 않도록 했다. 앱이 종료된 동안 변경된 파일은
다음 foreground 진입에서 확인한다. 이는 TTS native recovery WorkManager와 별개의 경계다.

## 코드 위치

- contract/reconcile: `src/library-folders/`
- device-local state: `src/library-folders/local-state.ts`
- Browser/Tauri adapter: `src/platform/library-folder-io.ts`
- Android adapter: `src/platform/android/library-folder-io.ts`
- Android SAF tree plugin: `src-tauri/mobile/android/DocumentIoPlugin.kt`
- controller/UI: `src/features/library-folders/`

## 남은 작업

- physical Android에서 tree 선택, 재실행 뒤 permission, 대량 TXT/EPUB/PDF/archive import와 rename/delete 검증
- packaged Windows/macOS/Linux에서 directory handle 지속성과 permission 재요청 검증
- 20,000개에 가까운 폴더의 실제 scan/import 메모리·시간 evidence
- native desktop watcher 또는 저비용 background change hint. 실제 import/IndexedDB mutation은 계속 foreground에서 수행
- 암호 archive의 자동 동기화 UX. 현재 password 없는 archive만 자동 처리하고 실패 항목은 panel에 남긴다.
- quick metadata가 유지된 채 content만 바뀌는 비정상 provider를 위한 명시적 정밀 hash scan
