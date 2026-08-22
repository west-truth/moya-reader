import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Dialog, trappedFocusTargetIndex } from './Dialog';

describe('Dialog', () => {
  it('renders an accessible modal relationship and named close control', () => {
    const markup = renderToStaticMarkup(
      <Dialog open title="책 가져오기" onClose={vi.fn()} closeLabel="가져오기 닫기">
        <button type="button">가져오기 시작</button>
      </Dialog>,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toMatch(/aria-labelledby="[^"]+"/);
    expect(markup).toContain('aria-label="가져오기 닫기"');
    expect(markup).toContain('책 가져오기');
  });

  it('allows a surface to scope backdrop styling without changing the shared modal class', () => {
    const markup = renderToStaticMarkup(
      <Dialog open title="설정" onClose={vi.fn()} backdropClassName="reader-settings-backdrop">
        설정 내용
      </Dialog>,
    );

    expect(markup).toContain('class="modal-backdrop reader-settings-backdrop"');
  });

  it('wraps focus only at the dialog boundaries', () => {
    expect(trappedFocusTargetIndex(-1, 3, false)).toBe(0);
    expect(trappedFocusTargetIndex(-1, 3, true)).toBe(2);
    expect(trappedFocusTargetIndex(0, 3, true)).toBe(2);
    expect(trappedFocusTargetIndex(2, 3, false)).toBe(0);
    expect(trappedFocusTargetIndex(1, 3, false)).toBeUndefined();
    expect(trappedFocusTargetIndex(0, 0, false)).toBe(-1);
  });
});
