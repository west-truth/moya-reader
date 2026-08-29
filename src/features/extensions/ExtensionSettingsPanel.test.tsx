import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppExtensionSnapshot } from '../../extensions/app-extension-manager';
import { ExtensionSettingsPanel } from './ExtensionSettingsPanel';

const moyaAI = {
  id: 'moya.ai',
  name: 'Moya AI',
  version: '1.0.0',
  description: 'AI 분석 기능',
  origin: 'bundled',
  trustLevel: 'trusted',
  defaultEnabled: true,
  canDisable: true,
  beta: true,
  enabled: true,
  state: 'active',
  permissions: ['analysis.workflow.execute'],
  contributions: [{ id: 'moya.ai.book', kind: 'analysis', title: 'Moya AI 분석' }],
} as const satisfies AppExtensionSnapshot;

const communityCatalog = {
  ...moyaAI,
  id: 'community.catalog',
  name: '커뮤니티 작품 소스',
  description: '커뮤니티 작품 목록',
  origin: 'community',
  trustLevel: 'sandboxed',
  permissions: ['external.source.list', 'external.source.download'],
  contributions: [{ id: 'community.catalog.files', kind: 'external_source', title: '작품 카탈로그' }],
} as const satisfies AppExtensionSnapshot;

describe('ExtensionSettingsPanel', () => {
  it('shows identity, trust, capabilities and permissions separately from community plugins', () => {
    const markup = renderToStaticMarkup(<ExtensionSettingsPanel extensions={[moyaAI]} setEnabled={vi.fn()} />);

    expect(markup).toContain('내장 익스텐션');
    expect(markup).toContain('커뮤니티 플러그인');
    expect(markup).toContain('Moya AI');
    expect(markup).toContain('v1.0.0');
    expect(markup).toContain('Beta');
    expect(markup).toContain('앱과 함께 검증됨');
    expect(markup).toContain('Moya AI 분석');
    expect(markup).toContain('앱이 제공한 AI 실행 경계 사용');
    expect(markup).toContain('설치된 커뮤니티 플러그인이 없습니다.');
  });

  it('explains external source listing and selected download permissions', () => {
    const markup = renderToStaticMarkup(
      <ExtensionSettingsPanel extensions={[communityCatalog]} setEnabled={vi.fn()} />,
    );

    expect(markup).toContain('외부 소스 · 작품 카탈로그');
    expect(markup).toContain('외부 작품·파일 목록 보기');
    expect(markup).toContain('선택한 외부 원문 가져오기');
  });
});
