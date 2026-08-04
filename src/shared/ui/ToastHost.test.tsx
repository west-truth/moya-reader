import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToastHost, toastAutoDismissDelay } from './ToastHost';

describe('ToastHost', () => {
  it('announces messages and exposes reader layout state without sibling selectors', () => {
    const markup = renderToStaticMarkup(
      <ToastHost
        readerActive
        addonOpen={false}
        toasts={[
          { id: 'success', message: '책을 가져왔습니다.', tone: 'success' },
          { id: 'danger', message: '가져오지 못했습니다.', tone: 'danger' },
        ]}
      />,
    );

    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('data-reader-active="true"');
    expect(markup).toContain('data-addon-open="false"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('role="alert"');
  });

  it('keeps actionable toasts until the user acts and gives errors enough reading time', () => {
    const action = { label: '실행 취소', onSelect: () => undefined };
    expect(toastAutoDismissDelay('info', action, 2800)).toBeUndefined();
    expect(toastAutoDismissDelay('danger', undefined, 2800)).toBe(6000);
    expect(toastAutoDismissDelay('success', undefined, 2800)).toBe(2800);
  });
});
