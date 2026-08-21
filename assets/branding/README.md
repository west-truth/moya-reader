# 모야 브랜드 자산

이 폴더의 두 PNG가 프로젝트 로고의 단일 원본이다. PWA나 Tauri의 파생 아이콘을 직접 수정하지 않는다.

- `moya-wordmark.png`: 가로형 `MOYA` 워드마크. 투명 배경 PNG를 사용한다.
- `moya-app-icon.png`: 정사각형 앱 심볼. 투명 배경 PNG를 사용한다.

로고를 바꿀 때는 위 파일을 **같은 파일명**으로 교체한 뒤 저장소 루트에서 다음 명령을 실행한다.

```bash
pnpm brand:generate
```

이 명령은 다음 위치를 한 번에 갱신한다.

- `public/branding/`: 앱 정보와 README에서 사용하는 워드마크
- `public/icons/`: favicon 및 PWA 32/192/512px 아이콘
- `src-tauri/icons/`: Windows, macOS, iOS와 Android용 Tauri 아이콘
- `src-tauri/gen/android/.../res/`: 이미 생성된 Android 프로젝트의 런처 아이콘

앱 아이콘은 반드시 정사각형 PNG, 워드마크는 가로형 PNG여야 한다. 이미지의 투명 여백도 디자인 일부로
간주해 생성 과정에서 자동 crop하지 않는다.
