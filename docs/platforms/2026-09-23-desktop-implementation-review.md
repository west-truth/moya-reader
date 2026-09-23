# 포터블 데스크톱 구현 검토

검토일: 2026-09-23. 대상: `40ee131..62a8e7b`, 작업 폴더의 `src-tauri/src/app.rs` 로그 순서 변경 포함.
상태: 아래는 검토 시점의 기록이다. 이후 사용자가 수정을 승인하고 최초 오프라인 실행 보장을 제외했다. 변경 사항과 검증 상태는 [구현 계획의 검토 후 수정](2026-09-23-desktop-release-plan.md#검토-후-수정--2026-09-23)에 기록한다.

## 결론

Tauri와 공통 UI·확장 실행기를 재사용하는 방향은 타당하다. 다만 현재 구현은 릴리즈 후보로 완성되지 않았고, 단일 EXE에 오프라인 WebView2까지 항상 넣는 선택으로 용량과 검증 비용이 커졌다. 포터블 앱 요구와 모든 PC에서 최초 오프라인 실행 보장은 별도의 요구다. 후자는 사용자와 재확정하기 전 기본 산출물에 강제할 필요가 없다.

기능을 더 붙이기 전에 배포 구성을 단순화하고, 보관소 전환과 오류 표시를 정리하는 편이 낫다. 저장소·리더 전체 재작성, Python 수집기 전면 이식, 범용 런타임 관리 프레임워크는 이번에 필요하지 않다.

## 실제 확인한 용량

로컬에 보관된 초기 Windows 후보 `/tmp/moya-portable-candidate/Moya.exe`를 실행하지 않고 내부 ZIP과 수집기의 PyInstaller 목차를 읽었다. 이 파일은 이전 후보 `35814004473`의 산출물이며 최신 후보 자체를 다시 측정한 것은 아니다.

| 구성                                       | EXE 내부 크기 | 판단                                    |
| ------------------------------------------ | ------------: | --------------------------------------- |
| Moya 실행 파일·프런트엔드 등, payload 제외 |      18.29MiB | 이 부분이 주된 용량 원인은 아님         |
| 소스 실행기용 Node                         |      32.74MiB | 로컬 JS 소스 실행에 필요                |
| Node 라이브러리 전체                       |       8.57MiB | 세부 파일 가지치기의 절감 효과는 제한적 |
| 메타데이터 수집기                          |      56.87MiB | Python과 Playwright 실행 환경 포함      |
| 기타·압축 목차                             |    약 0.95MiB | 우선 최적화 대상 아님                   |
| 초기 EXE 전체                              |     117.42MiB | WebView2 동봉 전 실측                   |
| 뒤에 추가된 고정 WebView2 CAB              |     294.22MiB | 빌드 코드에서 고정한 308,509,880바이트  |

초기 EXE 구성에 CAB를 더하면 약 412MiB다. 최신 후보의 정확한 EXE 크기를 이 합계와 동일하다고 단정하지 않는다. 이전에 안내한 약 420MB에는 Actions 아티팩트 ZIP 크기(420,655,338바이트)가 섞여 있었으며 EXE와 ZIP을 구분해야 한다.

수집기 내부에는 `playwright/driver/node.exe`가 별도로 존재한다. 압축 상태 **33.17MiB**, 해제 상태 약 **89MiB**로, 이미 포함한 소스 실행기용 Node와 역할이 겹친다. Playwright Python은 `PLAYWRIGHT_NODEJS_PATH`로 Node 경로를 지정할 수 있다. 다만 버전 호환과 Windows 실행을 확인한 뒤 하나로 공유해야 하며, 파일만 삭제하면 안 된다. [공식 구현](https://github.com/microsoft/playwright-python/blob/main/playwright/_impl/_driver.py)

## 먼저 해결할 동작 문제

### 1. WebView2 대체 경로는 아직 실패 상태

Windows 빌드와 일반 시작 단계는 진행됐지만 강제 fixed-runtime 경로는 제한 시간 안에 끝나지 않았다. [빌드 run](https://github.com/west-truth/moya-reader/actions/runs/35819049450), [같은 EXE 재검사](https://github.com/west-truth/moya-reader/actions/runs/35819833485).

이전의 “임시 파일이 없으므로 압축 해제를 시작하지 않았다”는 추론은 확정할 수 없다. `portable.rs`는 오류가 나면 staging을 지운다. 커밋된 `app.rs`는 오류 대화상자가 닫힌 **후** stderr를 쓰므로, CI가 대화상자에서 대기하면 실제 오류도 기록되지 않는다. 작업 폴더의 미커밋 변경은 이 로그 순서만 바로잡는다.

또 CAB 쓰기 핸들을 유지한 채 `expand.exe`를 시작한다. 이를 닫은 뒤 넘기는지와 실제 expand 종료 코드·stderr를 확인해야 한다. Windows 파일 공유 충돌 가능성은 아직 원인으로 입증되지 않았다. 환경변수 전달 역시 확정 원인이 아니다.

근거: [CAB 기록·해제](../../src-tauri/src/portable.rs), [초기 오류 처리](../../src-tauri/src/app.rs).

### 2. 보관소 생성·잠금 해제로 설정이 사라질 수 있음

보관소가 잠겨 있으면 로그인·기본 프록시 설정은 `SessionSourceCredentialVault`의 메모리에 저장된다. 사용자가 프록시를 저장한 다음 보관소를 만들거나 잠금 해제하면 실행기를 종료하고 별도 영구 vault로 다시 열기 때문에 세션 설정은 옮겨지지 않는다. 새 vault에 기본 프록시가 없으면 직접 연결로 돌아갈 수 있다.

네트워크 설정 패널도 이미 읽은 snapshot을 보관하므로 실제 설정이 바뀌어도 기존 주소가 화면에 남을 수 있다. “저장” 성공 후의 기대와 다르다. 비밀이 아닌 설정의 수명과 로그인 비밀값의 잠금을 분리하거나, 전환 시 필요한 설정을 명시적으로 유지해야 한다.

근거: [native vault 선택](../../scripts/extensions/native-entry.ts), [네트워크 설정 저장](../../apps/server/src/extensions/source-network-settings.ts), [설정 패널](../../src/features/extensions/SourceNetworkSettingsPanel.tsx).

### 3. 보관소 잠금 버튼이 진행 중인 소스 작업을 끊음

잠금·잠금 해제 명령이 모두 `stop_before_exit()`를 호출한다. host 종료 후 750ms 안에 끝나지 않으면 프로세스 트리를 강제 종료한다. UI는 진행 중 다운로드 여부와 관계없이 버튼을 허용한다. 따라서 읽고 있던 파일과 별개로, 내려받던 회차나 설치 작업은 중간 실패할 수 있다.

전환 전에 작업을 정리하거나 작업 중 전환을 보류하는 작은 조정이 필요하다. 잠금은 키 상태 변경과 실행기 종료·재시작을 하나의 전환으로 묶어, 동시에 들어온 시작 요청이 이전 키를 가진 host를 다시 만들지 못하게 해야 한다. 동시성 재현 검사는 아직 하지 않았다.

근거: [잠금 명령](../../src-tauri/src/portable_vault.rs), [host 종료](../../src-tauri/src/extension_runtime.rs), [버튼](../../src/features/extensions/PortableSourceVault.tsx).

### 4. Mangayomi 초기화 실패가 정상적인 미지원 상태로 가려짐

`MangayomiExtensionHost.open()` 오류를 `undefined`로 바꾸고, 프런트는 `features.mangayomi === false`이면 관리 기능을 숨긴다. 전체 snapshot은 `available: true`가 될 수 있다. 사용자는 저장소 읽기 실패와 의도적인 미지원 상태를 구분할 수 없다. 기존 목록이 있는 상태에서 refresh 실패도 삼키므로 오래된 항목이 남을 수 있다.

의도적으로 제외한 APK와 필수 JS host의 실패를 구별하고, 실패 원인의 안전한 코드·재시도만 제공하면 된다. 별도 대형 진단 시스템은 필요하지 않다.

근거: [초기화](../../scripts/extensions/native-entry.ts), [목록 갱신](../../src/extensions/packages/local-installed-extensions.ts).

### 5. 현재 smoke 성공 기준이 실제 앱 사용보다 약함

일반 시작 검사는 `node.exe`, `MoyaData/webview` 폴더와 프로세스 생존만 확인한다. webview 폴더는 실제 창 생성 전에 만든다. 고정 런타임 검사는 `msedgewebview2.exe`가 생기면 바로 앱을 종료한다. 이동 검사 역시 서재·설정 데이터를 넣고 읽는 방식은 아니다.

따라서 “정상 UI 실행·데이터 이동 확인”으로 보고하면 안 된다. UI 준비 신호 하나, 작은 서재/설정 저장 후 재실행·폴더 이동 하나 정도로 기준을 보강하면 된다. 전체 브라우저 테스트를 반복할 이유는 없다. 두 번째 프로세스 종료가 실제 기존 창 포커스까지 증명하는 것도 아니다.

근거: [Windows smoke](../../scripts/desktop/smoke-portable-windows.ps1).

## 줄일 수 있는 비용과 복잡성

- **WebView2 무조건 동봉:** 기본 배포는 시스템 WebView2 사용을 권장한다. 없을 때만 최초 준비를 안내하거나 공식 런타임을 내려받는 방식과, 최초 오프라인 실행까지 가능한 큰 EXE를 구분한다. 앱 자체는 설치형으로 바뀌지 않는다. Microsoft도 Evergreen·Fixed 배포를 별도로 제공한다. Fixed를 동봉하면 해당 버전의 보안 업데이트도 앱 배포자가 관리해야 한다. [공식 배포 안내](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
- **중복 Node:** 수집기의 Playwright가 동봉한 Node를 소스 실행기와 공유할 수 있는지 확인한다. 실측으로 약 33MiB 절감 후보다. WebView2 비동봉과 함께라면 **80~100MiB 안팎**을 검토 목표로 삼을 수 있으나, 아직 재빌드 실측값은 아니다.
- **수집기 이중 압축 해제:** 바깥 Moya.exe가 수집기 EXE를 한 번 풀고, 수집기는 PyInstaller `--onefile`이라 실행할 때 다시 임시 폴더에 푼다. 수집기 내부 목차의 비압축 합계는 약 144MiB다. 실제 임시 디스크량은 이 합계와 다를 수 있다. 포터블용 내부 수집기를 `--onedir`로 만들면 바깥 배포물은 여전히 EXE 하나이면서 매번 내부 재해제하는 비용을 줄일 수 있다. 기존 installer 대상은 함께 검토해야 한다. [PyInstaller 동작](https://pyinstaller.org/en/stable/operating-mode.html)
- **업데이트 때 실행기 전체 복제:** `payload 해시 + WebView2 해시` 하나가 전체 runtime 디렉터리를 결정한다. 작은 JS 수정이나 CAB 교체에도 Node·수집기까지 다시 풀고, 이전 runtime은 남긴다. 구성요소별 안정적인 버전 키로 재사용하고, 이전 앱 실행에 필요한 버전을 구분한 명시적 정리 UX를 두는 정도가 적절하다. 사용자 데이터까지 추측해서 지우는 orphan 청소는 하지 않는다.
- **매 push 전체 Windows 빌드:** 현재 branch의 모든 push가 Node/Python 번들과 Rust 전체 빌드를 유발한다. 진단 스크립트 수정에도 자동 빌드가 떠서 수동 취소를 반복했다. 개발 중은 수동 후보 빌드·기존 EXE 재검사, 이후 PR은 관련 경로 변경에 한정하는 편이 낫다. Rust 빌드 캐시도 현재 workflow에 없다.
- **우선순위 낮은 최적화:** Node 라이브러리 전체가 압축 후 약 8.6MiB다. 여기의 보고서·trace viewer 파일을 무리하게 골라 지우거나 번들러를 새로 만드는 것보다 294MiB 런타임 정책과 33MiB 중복 Node를 먼저 정리한다. Python 전체를 JS로 재작성하는 것도 지금은 비용 대비 이득이 낮다.

Windows 10을 지원 대상으로 넓힐 때는 fixed WebView2 120 이상 unpackaged 앱의 추가 ACL 요건도 필요하다. 현재 코드에는 그 처리가 없으며, Windows 11 후보 확인과 Windows 10 지원을 구분해야 한다. [Microsoft 요건](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#details-about-the-fixed-version-runtime-distribution-mode)

## 유지할 설계와 남은 범위

공통 UI·확장 런타임 재사용, 포터블 데이터 경로 집중, 다운로드한 실행기 해시 검증, 프로필 중복 실행 방지, 잠긴 상태에서도 공개 소스 사용, 기본 JS 빌드에서 Java/APK 제외는 유지할 가치가 있다. EPUB 전체 ArrayBuffer 제거도 유효한 개선이다.

다만 현재 EPUB 경로는 이미지 항목을 검사 때와 저장 때 다시 읽는 기존 iterator 경로이며, 파일 기반 desktop 저장을 완성한 것은 아니다. 로컬 백업 256MiB/500항목, 네이티브 파일 IO, 다운로드 종료/절전 복구, 실제 소스 전체 사용 흐름, 다른 PC 데이터 이동은 여전히 미완료다.

재개 시 권장 순서: 배포 런타임 정책 확정 → 보관소 전환/설정 보존/오류 표시 → 작은 Windows 실행·데이터 보존 확인 → 파일 저장·백업 → 다운로드 수명과 실제 소스 흐름. 기능별 커밋은 유지하되 진단 수정마다 전체 후보 빌드를 반복하지 않는다.
