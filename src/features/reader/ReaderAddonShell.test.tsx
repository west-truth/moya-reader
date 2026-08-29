import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CORE_READER_ADDON_TABS, ReaderAddonShell } from './ReaderAddonShell';

describe('ReaderAddonShell', () => {
  it('exposes dialog and tab semantics while preserving the active tool', () => {
    const markup = renderToStaticMarkup(
      <ReaderAddonShell activeTab="outline" tabs={CORE_READER_ADDON_TABS} setActiveTab={vi.fn()} close={vi.fn()}>
        <p>목차 내용</p>
      </ReaderAddonShell>,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('role="tabpanel"');
  });

  it('renders a trusted extension tab from the host-provided descriptor list', () => {
    const extensionTab = {
      id: 'example.reader.tools.summary',
      label: '요약',
      icon: 'file-text',
      order: 70,
    } as const;
    const markup = renderToStaticMarkup(
      <ReaderAddonShell
        activeTab={extensionTab.id}
        tabs={[...CORE_READER_ADDON_TABS, extensionTab]}
        setActiveTab={vi.fn()}
        close={vi.fn()}
      >
        <p>확장 결과</p>
      </ReaderAddonShell>,
    );

    expect(markup).toContain('요약');
    expect(markup).toContain('확장 결과');
    expect(markup).toContain('aria-selected="true"');
  });
});
