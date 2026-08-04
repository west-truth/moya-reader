import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReaderAddonShell } from './ReaderAddonShell';

describe('ReaderAddonShell', () => {
  it('exposes dialog and tab semantics while preserving the active tool', () => {
    const markup = renderToStaticMarkup(
      <ReaderAddonShell activeTab="outline" setActiveTab={vi.fn()} close={vi.fn()}>
        <p>목차 내용</p>
      </ReaderAddonShell>,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('role="tabpanel"');
  });
});
