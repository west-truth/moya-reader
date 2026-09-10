# 독서·가져오기 UX 검증

## 모바일 책장 선택 바 (2026-09-10)

- 699px 이하에서는 한 줄 아이콘 바로 시작한다. 펼치면 책장·태그·즐겨찾기 해제를 표시하며 선택 종료 후
  다시 선택할 때는 접힌 상태다. 기존 다운로드 모양 버튼은 작품 정보 내보내기 동작을 유지한다.
- 펼친 영역은 55dvh로 제한하고, 목록 끝에 스크롤 공간을 확보해 바 아래의 마지막 작품도 위로 올려 선택한다.
- Library 23 tests, Web 타입 검사·빌드, 변경 파일 lint/format 및 CSS 검사를 통과했다. Chromium 합성 1,000권
  브라우저 검사는 320/390px와 667px 가로 화면, 두 목록 레이아웃 및 접힘/펼침 상태의 마지막 작품 선택,
  즐겨찾기·내보내기·휴지통·책장·태그 작업과 선택 재시작을 검증했다.
- WebKit에서도 기능 검증은 통과했으나 확장된 스트레스 검사 마지막의 무경고 gate는
  `ResizeObserver loop completed with undelivered notifications.` 1건으로 실패했다. 기존 짧은 검사는
  통과하며, 새 경고를 필터링하거나 Reader 코드를 변경하지 않았다. 실제 모바일 Safari 확인은 남아 있다.

## iPad 지속 스크롤 후속 교정 (2026-09-09)

- 일반 scroll/pointercancel마다 전체 본문에 다음 화 당기기 복귀 transform을 적용하던 경로를 제거했다.
  실제 당기기만 복귀하며, 모드 가시성 변경은 문단 높이 캐시를 보존한다. 행 등록 시 중복 동기 측정을 제거했다.
- 다양한 길이의 문단을 위로 스크롤하는 60프레임 검사에서 기존 코드의 본문 속성 변경 123회를 재현했다.
  수정 후 iPad WebKit 834×1194와 Android 프로필 Chromium 393×727에서 속성 변경과 transform 모두 0회,
  전환 전후 문단 높이 보존, 제한된 가상 행 수를 확인했다.
- 실행: `node scripts/performance/reader-position-smoke.mjs --scroll-stability-only`.
  iPad는 `READER_UI_BROWSER_ENGINE=webkit`, Android 프로필은 `--android`를 사용한다.
- Reader UX 85개 테스트, Edge 실제 Reader 위치·resize·완독 복원 검사, WebKit 자동 모드 전환,
  WebKit/Edge 약한·강한 회차 경계 입력, 타입 검사와 Web 빌드를 통과했다.
- 공통 Reader 변경은 Android에도 적용되며 Android 네이티브 코드는 변경하지 않았다. 합성 입력·device profile은
  실제 iPad/Android 관성 스크롤이나 GPU 성능 검증이 아니다. 물리 기기에서의 체감 확인은 남아 있다.

## 텍스트 소스·회차 목록·동기화 변경 검증 (2026-09-05)

- 공개용 `pnpm check:web-server` 통과: 90개 Vitest 파일에서 738개 통과/3개 생략, 전체 타입 검사,
  lint·공개 소스/라이선스 경계·Hosted 정적 검사 264개·Web/서버 production build를 포함합니다.
- 추가 텍스트 계약/목차/Reader/설정 검사에서 PostgreSQL revision 검증식 오류 2건을
  발견했습니다. 후속 migration 0045로 수정한 뒤 실제 DB의 가져오기·migration 검사 16개가 모두 통과했습니다.
  기존 migration checksum을 보존하며 길이 경계와 동시 저장 충돌을 검증합니다.
- 최종 범용 텍스트 서버 Node 테스트는 48개 통과/브라우저 transport 선택 검사 1개 생략입니다.
  범용 client/wire/broker 회귀 35개도 통과했습니다. 사이트별 구현과 해당 검증은 공개 제품 범위에 포함하지 않습니다.
  Hosted 텍스트 소스 Compose 조합의 정적 검증과 전체 PR 범위의 포맷 검사도 통과했습니다.
- 실제 외부 사이트의 대량 다운로드 처리량, 장시간 self-host 사용 및 Funnel 지연 개선 수치는 이 검사의
  범위 밖입니다. 이 PR의 Windows native/Protected Compose 실행 결과는 GitHub Actions에서 별도로 확인합니다.

## 현재 동작

- 텍스트 Reader는 활성 화면만 읽기 위치를 저장하며, 스크롤/페이지 전환의 저장 순서를 보장한다.
  책 전체 검색은 화 이동 시 결과 위치를 유지하고 완성된 마지막 페이지는 완독으로 저장한다.
- 만화/PDF 본문 버튼은 클릭과 키보드로 작동한다. 너비 맞춤 100%에서도 긴 이미지의 세로 이동을
  허용하며 연속 읽기는 화면 중앙을 포함하는 페이지를 현재 위치로 선택한다. 잘못된 페이지 번호는
  기존 번호로 복구한다. Escape는 열린 패널을 먼저 닫고 Android 뒤로가기에 처리 여부를 전달한다.
- 파일이나 대상 작품을 다시 선택하면 오래된 가져오기 계획은 폐기한다. 기본 백업 충돌 처리는 개별
  지정하지 않은 작품에 적용되며, 외부 소스의 추가 조회 실패는 기존 목록과 재시도 위치를 유지한다.
- 실패한 본문 페이지는 명시적으로 재시도한다. 숨은 화면의 전체 조판과 인접 회차 전체 선로딩을 막고,
  만화 이미지는 현재 페이지 우선으로 최대 3개를 동시에 읽는다. 새 회차 추가 시 기존 이미지 캐시는 유지한다.
- 페이지 이동 취소는 Blob뿐 아니라 JSON metadata와 오류 응답 본문 수신에도 전달된다. 지연된 이전
  요청이 이미지 로더 슬롯을 계속 점유하지 않으며, 기존 응답 header timeout 정책은 유지한다.
- 책장은 100권 초과 목록을 가상화한다. 동기화 상세는 상태별 100건 미리보기와 명시적 전체 조회를
  제공하며 일반 독서·초기화에서는 outbox 이력을 전부 불러오지 않는다. 만화 하단 탐색바는 전체 페이지를 이동한다.

## 검증 명령

```sh
pnpm test:reader-ux
pnpm check:reader-position
pnpm check:library-performance
pnpm build
pnpm check:fixed-document-ui
```

`test:reader-ux`는 공개 Web/Server CI에 포함된다. 브라우저 명령은 합성 데이터와 새 브라우저 context를
사용하며 실제 계정이나 사용자 저장소를 사용하지 않는다. 기본 브라우저는 Microsoft Edge이며 설치된
다른 Chromium 채널은 `READER_UI_BROWSER_CHANNEL`로 지정한다. 고정 문서 검증은 먼저 생성한 `dist`를 사용한다.

Reader 위치 검증은 120문단 및 한 문단 회차의 resize·완독·원본 offset 보존을 확인한다. 책장 검증은
1,000권의 가상 목록과 focus를 확인하고 고정 문서 검증은 실제 앱에 합성 CBZ를 가져와 버튼·숫자 입력·
모바일 터치 에뮬레이션을 확인한다. 브라우저 검증은 물리 모바일이나 배포된 self-host 검증을 대체하지 않는다.

DB/schema, 원문, archive 형식과 provider 경계는 유지한다. 대용량 백업 분할, 앱 종료 후 지속되는 가져오기,
만화 추가 시 전체 메타데이터 처리 최적화는 별도 범위다.
