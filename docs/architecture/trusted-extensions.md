# 신뢰 익스텐션 v1 개발 가이드

상태: bundled/source-reviewed extension foundation 구현, community package loader 미구현
기준일: 2026-08-24

모야의 익스텐션 v1은 앱 소스와 함께 검토·빌드되는 기능을 공통 manifest와 lifecycle로 분리하는 경계다.
`설정 → 익스텐션`에서 이름, 버전, 신뢰 수준, 제공 기능과 요청 권한을 확인하고 익스텐션별로 켜거나 끌 수
있다. 활성 상태는 브라우저에 영구 저장되며, 비활성화하면 해당 Reader 탭, 명령, AI workflow, 작품 보강과
외부 source contribution이 runtime에서 즉시 제거된다.

현재 버전은 임의의 ZIP/npm 패키지나 Mihon APK를 설치하는 community plugin loader가 아니다. `community`와
`sandboxed` 표시는 향후 loader를 위한 모델/UI 구분일 뿐이며, 지금 실행되는 정의는 저장소에서 검토한
`trusted` TypeScript 코드다. 제3자 코드를 main browser realm에서 동적으로 실행하지 않는다.

## Core와 익스텐션의 경계

- Library/Reader, import, 원문 보존, 저장소와 일반 system TTS는 core다.
- API 기반 AI beta와 AI를 이용한 TTS 준비 workflow는 bundled 익스텐션으로 관리한다.
- Hosted/native provider 호출, secret, job 복구, canonical graph 승인과 TTS cache는 host 경계를 통과한다.
- Dropbox, Google Drive와 Suwayomi 같은 제품 기본 source는 익스텐션 토글 대상이 아니다.
- 플러그인이 제공하는 추가 source만 익스텐션 lifecycle을 따라 켜고 끈다.

## Manifest

공개 계약은 `packages/extension-contracts/index.ts`의 `ExtensionManifestV1`이다. Manifest와 API 버전은 현재
모두 `1`이며 ID는 소문자 dotted namespace, version은 semver를 사용한다. 모든 contribution ID는 extension
ID로 시작해야 한다.

```ts
import type { ExtensionManifestV1 } from '@noveldesk/extension-contracts';

export const manifest = {
  manifestVersion: 1,
  id: 'example.reader.notes',
  name: '예제 메모 도구',
  version: '1.0.0',
  engine: { moyaApi: 1 },
  permissions: ['reader.addon.render', 'reader.context.read'],
  contributes: {
    readerAddonTabs: [
      {
        id: 'example.reader.notes.panel',
        label: '메모',
        icon: 'notes',
      },
    ],
  },
} satisfies ExtensionManifestV1;
```

선언하지 않은 권한이나 contribution을 activation 중 등록하면 해당 익스텐션은 실패 상태가 되고 이미 등록한
handler는 rollback된다. 같은 ID의 중복 등록도 거부한다.

## 현재 contribution과 권한

| Contribution              | 대표 권한                                            | 용도                                         |
| ------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `readerAddonTabs`         | `reader.addon.render`, 필요 시 `reader.context.read` | Reader 보조 탭                               |
| `commands`                | `app.command.execute`                                | host가 호출하는 명령 handler                 |
| `analysisWorkflows`       | `analysis.workflow.execute`                          | chapter/book AI action 또는 managed workflow |
| `bookEnrichmentProviders` | `book.enrichment.propose`                            | 표지·metadata 후보 제안                      |
| `externalSources`         | `external.source.list`, `external.source.download`   | 추가 cloud/catalog source                    |

Manifest가 허용하는 정확한 enum은 항상 `packages/extension-contracts/index.ts`를 기준으로 한다. 새 권한은 실제
host API가 생길 때 함께 추가하고, 이름만 미리 넓게 만들지 않는다.

## 구현 순서

1. `src/extensions/builtin/` 아래에 `TrustedExtensionDefinition`을 만든다. 제품에 기본 등록하지 않을 실험
   구현은 `src/extensions/examples/`에 두고 development bootstrap이나 test에서만 주입한다.
2. Manifest에 필요한 최소 권한과 contribution descriptor를 먼저 선언한다.
3. `activate(context)`에서 descriptor와 같은 contribution ID를 등록하고, cleanup이 필요하면 disposable을
   반환한다.
4. 제품 bundled 기능이면 `src/extensions/app-extension-runtime.ts`의 registration에 origin, trust level,
   기본 활성값과 비활성화 가능 여부를 명시한다.
5. AI/TTS managed workflow는 manifest descriptor와 같은 ID의 runner를
   `TrustedWorkflowRunnerRegistry`에도 등록한다. UI, Hosted 실행·복구와 native 실행이 모두 이 durable workflow
   identity를 전달해야 한다.
6. manifest validation, enable/disable 영속성, activation rollback과 해당 contribution surface의 focused test를
   추가한다.

## Host API 안전 원칙

- 익스텐션에 repository, raw `Novel`, 원문 전체, provider token, API key, arbitrary `fetch`를 넘기지 않는다.
- 작품 보강은 bounded public descriptor를 받아 후보만 반환한다. 실제 metadata/cover 변경은 사용자가 비교·승인한
  뒤 host CAS/provenance 경계가 수행한다.
- 외부 source는 host broker가 연결, 목록, 다운로드와 credential을 소유한다. 탐색만으로 원문을 받지 않으며
  import는 사용자의 명시적 동작으로 기존 `ImportService`를 통과한다.
- 일반 system TTS는 익스텐션을 꺼도 계속 작동해야 한다.
- 비활성화와 activation 실패는 다른 익스텐션이나 Reader teardown을 막지 않아야 한다.

## 참고 구현

- `src/extensions/builtin/reader-info-extension.tsx`: Reader add-on
- `src/extensions/builtin/moya-ai-extension.tsx`: bundled AI beta와 managed workflow descriptor
- `src/extensions/builtin/book-ai-tts-workflow-extension.tsx`: workflow runner registration
- `src/extensions/examples/library-book-enrichment-extension.ts`: 개발용 작품 보강 fixture
- `src/extensions/examples/mock-external-source-extension.ts`: 개발용 source fixture
- `src/features/extensions/ExtensionSettingsPanel.tsx`: 관리 UI
- `src/extensions/app-extension-manager.test.ts`: enablement와 reactive lifecycle
- `src/extensions/trusted-extension-registry.test.tsx`: permission, activation과 rollback 경계

Community plugin을 실제 설치 가능하게 만들 때는 이 trusted API를 그대로 신뢰해 외부 코드를 실행하지 않는다.
패키지 서명/hash, 별도 loader, sandbox/worker 또는 self-host gateway, 권한 승인과 업데이트·철회 정책을 먼저
구현한 뒤 `origin: community`, `trustLevel: sandboxed` 경로를 연다.
