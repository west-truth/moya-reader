# Windows·Android 네이티브 빌드 가이드

이 저장소는 웹·서버뿐 아니라 Tauri v2 데스크톱과 Android 소스를 함께 제공합니다. 현재 네이티브 배포물은
개발자 소스 빌드 단계이며, 서명된 Windows installer와 Android APK/AAB는 GitHub Releases에 제공되지 않습니다.

## 공통 준비

- Git
- Node.js 22
- Corepack과 pnpm 11.7
- Rust stable과 Cargo

```bash
corepack enable
pnpm install --frozen-lockfile
rustup update stable
```

실제 API key, service-account JSON, keystore와 signing password는 저장소에 넣지 마십시오. `.env.example`과
`secrets/vertex/.gitkeep`은 설정 위치만 설명하는 빈 경계입니다.

## Windows 데스크톱

### 추가 준비

- Windows 10 또는 11
- Microsoft Edge WebView2 Runtime
- Visual Studio 2022 Build Tools의 Desktop development with C++ workload
- Rust MSVC toolchain

```powershell
rustup default stable-x86_64-pc-windows-msvc
pnpm check:desktop
pnpm tauri:dev
```

로컬 release와 NSIS installer를 만들려면 다음 명령을 사용합니다.

```powershell
pnpm tauri:build
```

결과물은 `src-tauri/target/release/bundle/nsis/`에 생성됩니다. `src-tauri/target/`과 installer는 Git에서
제외됩니다. 이 로컬 build 성공은 코드 조합을 확인하는 개발 gate이며 공식 서명·배포 승인을 의미하지 않습니다.

### 포터블 EXE 후보

Windows x64에서 단일 파일 후보를 만들려면 `pnpm desktop:portable:win`을 실행합니다. 출력은
`release/Moya.exe`입니다. 설치 프로그램은 생성하지 않습니다. 첫 실행 시 EXE 옆에
`MoyaData/`가 생기며 WebView 데이터, 네이티브 작업 기록과 동봉한 Node·메타데이터 실행기가 이곳에 놓입니다.
포터블 빌드의 앱 식별자는 `app.moya.reader`입니다. 이전 내부 시험용 EXE와 데이터 호환성은 보장하지 않습니다.
EXE를 교체할 때는 앱을 종료하고 `MoyaData/`는 그대로 둡니다.
Windows 후보 workflow는 수동 실행합니다. 매 push마다 전체 Windows 빌드를 반복하지 않습니다.
`artifact_run`을 주면 기존 후보를 다시 빌드하지 않고 실행 검사만 합니다. 오래된 후보에는 새 smoke 준비 신호가 없으므로 현재 형식의 후보를 지정해야 합니다.
검사는 실제 WebView의 React 화면 준비, 중복 실행 차단, 전체 폴더 이동 뒤 작은 설정 값 보존을 확인합니다.
이는 전체 서재 이동이나 실제 사이트 로그인을 대신하지 않습니다.

이 명령은 Python 수집기와 Windows Node 런타임을 빌드 중에 묶습니다. 기본 빌드는 JS 소스를 대상으로 하며
APK/Java 실행기 포함은 `MOYA_BUNDLE_APK=1`로 별도 선택합니다.
WebView2는 EXE에 넣지 않고 PC에 설치된 Evergreen Runtime을 사용합니다. 없으면 공식 설치 안내를 표시합니다.
CAB 다운로드·EXE 뒤 부착·자체 WebView2 해제 경로는 제거했습니다.

포터블 수집기는 내부적으로 PyInstaller `--onedir`를 사용하여 실행할 때마다 Python을 임시 폴더에 다시 풀지 않습니다.
배포물은 여전히 단일 Moya.exe입니다. Python Playwright의 중복 Node를 제거하고 `PLAYWRIGHT_NODEJS_PATH`로
동봉 소스 실행기의 Node를 공유합니다. 후보 검사에서 실제 수집기 EXE의 `--check-runtime`으로 이 연결을 확인합니다.
기존 설치형 수집기는 `--onefile`을 유지합니다.
[Playwright 실행기 선택](https://github.com/microsoft/playwright-python/blob/main/playwright/_impl/_driver.py).

## Android

### 추가 준비

- JDK 21
- Android Studio 또는 command-line SDK
- Android SDK Platform 36과 Build Tools
- Android NDK side-by-side 설치본 (`28.2.13676358` 검증 기준)
- 테스트 기기 또는 Android emulator

환경 변수를 설정합니다.

```text
JAVA_HOME=<JDK 21 경로>
ANDROID_HOME=<Android SDK 경로>
ANDROID_SDK_ROOT=<Android SDK 경로>
NDK_HOME=<선택: 사용할 NDK 경로>
```

Rust target을 설치하고 준비 상태를 확인합니다.

```bash
rustup target add aarch64-linux-android x86_64-linux-android
pnpm check:mobile-readiness
pnpm check:android-rust
```

clean clone에는 로컬 Cargo 경로를 담는 동적 Tauri Gradle 파일이 의도적으로 없습니다. 한 번 초기화한 뒤
debug build를 실행합니다. 이 과정에서 생성되는 로컬 경로 파일은 Git에 추가하면 안 됩니다.

```bash
pnpm tauri:android:init
```

SDK·NDK·Rust target을 모두 요구하는 엄격한 검사는 다음과 같습니다.

```bash
pnpm check:mobile-readiness:strict
pnpm check:android-rust:strict
```

### Debug package 만들기

ARM64 실기기용:

```bash
pnpm tauri:android:build:arm64-debug
```

x86_64 emulator용:

```bash
pnpm tauri:android:build:x86_64-debug
```

이 명령은 production 웹 asset, Rust Android library와 Gradle debug package를 함께 만듭니다. 표준 Tauri
개발 실행은 연결된 기기 또는 emulator가 준비된 상태에서 다음 명령을 사용할 수 있습니다.

```bash
pnpm tauri:android:dev
```

Gradle 출력, JNI library, generated web asset과 APK/AAB는 모두 Git에서 제외됩니다. 생성된 debug APK는
개발·검증 전용이며 배포용으로 서명되어 있지 않습니다.

## 현재 Android 제한

- package identifier `com.local.noveldeskreader`는 기존 호환성과 개발을 위한 임시 값입니다.
- signed release APK/AAB와 Play Store용 signing 구성은 아직 없습니다.
- emulator alpha는 확인했지만 물리 기기 파일 import, 장시간 background TTS, process death와 업데이트는
  release gate로 남아 있습니다.
- release signing을 추가할 때 keystore와 password는 GitHub Actions secret 또는 로컬 보안 저장소에서만
  주입해야 합니다.

## 검사 역할

| 명령                             | 확인 범위                                                    |
| -------------------------------- | ------------------------------------------------------------ |
| `pnpm check:web-server`          | 웹·서버 형식, 라이선스, 타입, 전체 테스트와 production build |
| `pnpm check:desktop`             | production 웹 build와 Tauri Rust compile                     |
| `pnpm check:rust`                | Rust format, Clippy와 native unit test                       |
| `pnpm check:mobile-readiness`    | Android project와 adapter 구성의 정적 준비 상태              |
| `pnpm check:android-rust:strict` | 설치된 Android Rust target의 실제 compile                    |

Docker Compose 서버만 운영하는 경우에는 JDK, Android SDK와 Rust가 필요하지 않습니다.
