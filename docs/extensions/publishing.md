# 공개 확장 릴리스 절차

이 문서는 자체 Moya JS/TS 소스와 `.moyaext` 배포를 위한 절차다. Mangayomi 원본 JS는 별도
[호환 지원 범위](mangayomi-compatibility.md)를 따른다. 아래 도구는 tarball 배포 준비 상태이며 npm에 게시하지 않았다.

## 외부 개발 환경

Node.js 22.12 이상과 배포받은 `@moya/extension-cli`, `@moya/extension-sdk` tarball을 설치한다.
Moya 소스 저장소나 운영 서버의 비밀키·환경 파일은 필요 없다.

```sh
npm install --save-dev /path/to/moya-extension-cli-0.1.0.tgz /path/to/moya-extension-sdk-0.1.0.tgz
npx moya-extension init source --id org.example.catalog --kind text --name "Example catalog"
npx moya-extension check source
npx moya-extension run source --method source.getContent --input source/content-input.json --fixture source/fixtures.json
npx moya-extension preview source --method source.getContent --input source/content-input.json --fixture source/fixtures.json
```

`--kind images`는 만화용 예제다. 생성된 예제 데이터/도메인은 합성 데이터이므로 실제 소스 구현과 테스트로 교체한다.
`preview`는 임의의 `127.0.0.1` 포트에서 fixture 결과를 표시하고 파일 변경을 감시한다. 실제 사이트 요청은
명시적 `--network`에서만 가능하다.
템플릿은 시작점이지 공개할 실제 사이트 확장이 아니다. 안정적인 소스·작품·회차 ID, 원문 순서,
빈 목록과 오류의 구분, 중단된 요청 처리, 최소 networkOrigins를 유지한다.

실사이트 테스트는 `--network`를 명시하고 입력 JSON으로 작품/회차를 선택한다. 정상 HTTP 응답만 확인하지 말고
목록 → 상세 → 회차 → 본문/이미지 바이트 → 실제 Moya에서 읽기까지 확인한다. 로그인 페이지·오류 HTML·빈 본문을
성공으로 처리하지 않는다. 사이트의 인증·차단 문제는 호스트 미지원 메서드와 구분해 릴리스 노트에 기록한다.

## 불변 패키지와 저장소 생성

manifest의 버전을 올리고, `updates.repository`를 사용하는 경우 최종 공개 index 주소와 일치시킨다.
확장 ID와 기존 작품·회차 ID는 유지한다. 같은 버전의 파일을 조용히 바꾸지 않는다.

```sh
npx moya-extension keygen publisher-keys
mkdir release
npx moya-extension pack source --key publisher-keys/publisher.pem --out release/org.example.catalog-1.0.0.moyaext
npx moya-extension index release --url https://extensions.example/index.json --name "Example sources" --out release/index.json
```

`index`는 archive를 검증한 후 실제 manifest의 ID/버전과 파일 전체 SHA-256으로 목록을 만든다.
같은 ID가 두 번 있으면 임의로 최신 버전을 고르지 않고 거부한다. 최신 archive 하나씩 있는 staging 디렉터리를
사용한다. archive와 index는 같은 공개 디렉터리에 두며, 파일명에 공백 등이 있으면 URL 인코딩한다.
기존 출력 파일을 덮어쓰지 않는다. 새 릴리스 디렉터리에서 작업한다.

생성된 디렉터리를 HTTPS 정적 호스팅에 게시할 수 있다. archive를 먼저 올리고 마지막에 index를 교체해
아직 없는 파일을 목록이 가리키지 않게 한다. 예전 archive URL도 유지하면 롤백·감사에 도움이 된다.
CLI는 파일 생성만 하며 원격 업로드나 운영 Moya 설치는 수행하지 않는다.

`keygen`은 새 디렉터리에 P-256 게시자 키를 생성하고 공개키 fingerprint만 출력한다. 기존 키 디렉터리는
덮어쓰지 않는다. POSIX에서 디렉터리 권한은 0700, 개인키는 0600이며 Windows에서는 별도 파일 접근 권한으로
보호한다. `publisher.pem`은 공개 디렉터리·소스 저장소에 넣지 않고 별도로 보관한다. 업데이트도 같은 키를
사용한다. 키를 잃거나 바꾸면 기존 사용자의 게시자 pin과 일치하지 않는다.

`pack --key`는 앱의 기존 ECDSA-P256-SHA256 서명 형식을 사용하고 생성한 패키지를 다시 검증한다.
개인키를 패키지에 포함하지 않는다. 키 옵션이 없으면 기존처럼 unsigned package이며 SHA-256은 파일 무결성만
확인할 뿐 게시자 신원을 인증하지 않는다. 독립 CLI는 PEM 파일을 사용하며 HSM/KMS나 암호화된 키의 대화형
비밀번호 입력은 지원하지 않는다. 게시자 서명은 코드 품질이나 사이트 이용 권한에 대한 보증이 아니다.

## 릴리스 승인 기준

- fixture: 정상/빈 결과, 다음 목록 페이지, 비정상 응답, 회차 순서, 본문 변환, 필요한 인증 상태를 검사한다.
- 독립 도구: checkout 밖에서 생성·검사·실행·pack·index까지 검증한다.
- 격리 앱: 파일/저장소 설치, 소스 검색, 다운로드·읽기, 업데이트, 재시작 후 상태, 비활성 상태 유지를 검사한다.
- 권한 변경: 새 도메인·저장 공간·인증 요구가 있으면 사용자가 검토할 수 있도록 릴리스에 기록한다.
- 출처: 가져온 원본 revision·라이선스·수정 내용과 미지원 기능을 기록한다. 자격 증명은 fixture나 로그에 넣지 않는다.

공통 호스트 테스트 통과를 모든 사이트의 실사용 성공으로 대체하지 않는다. 사이트별 검증 일자와
실제 확인한 메서드·콘텐츠 종류를 남긴다. 지원 불가 조건은 성공 목록에서 제외한다.

## 도구 자체 검증

```sh
corepack pnpm exec vitest run scripts/extensions/project.test.ts scripts/extensions/scaffold.test.ts scripts/extensions/repository.test.ts
corepack pnpm exec vitest run scripts/extensions/preview.test.ts
corepack pnpm test:extension-sdk
corepack pnpm test:extension-cli
```

CLI 검사는 실제 npm tarball을 임시 디렉터리에 설치하므로 npm registry 접근이 필요할 수 있다.
텍스트·만화 테스트 콘텐츠는 오프라인 fixture이며 운영 계정이나 데이터베이스를 사용하지 않는다.
