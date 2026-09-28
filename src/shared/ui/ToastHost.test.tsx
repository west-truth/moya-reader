import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastHost } from './ToastHost';
import { toastAutoDismissDelay, useToastController } from './toast-controller';

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

  it('gives actions, errors and long messages enough time without lingering forever', () => {
    const action = { label: '실행 취소', onSelect: () => undefined };
    expect(toastAutoDismissDelay('info', action, 2800)).toBe(8000);
    expect(toastAutoDismissDelay('danger', undefined, 2800)).toBe(6000);
    expect(toastAutoDismissDelay('success', undefined, 2800, '저장했습니다.')).toBe(2800);
    expect(toastAutoDismissDelay('info', undefined, 2800, '가'.repeat(80))).toBe(5600);
    expect(toastAutoDismissDelay('info', undefined, 2800, '가'.repeat(400))).toBe(7000);
  });

  it('marks leaving toasts so they can animate out', () => {
    const markup = renderToStaticMarkup(
      <ToastHost
        readerActive={false}
        addonOpen={false}
        toasts={[{ id: 'bye', message: '닫힘', tone: 'info', leaving: true }]}
        onDismiss={() => undefined}
      />,
    );
    expect(markup).toContain('data-leaving="true"');
    expect(markup).toContain('aria-label="알림 닫기"');
  });
});

describe('useToastController', () => {
  function harness() {
    let controller!: ReturnType<typeof useToastController>;
    function Probe() {
      controller = useToastController();
      return null;
    }
    act(() => {
      create(<Probe />);
    });
    return () => controller;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps undo available when routine notifications arrive together', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const controller = harness();
    const undo = { label: '실행 취소', onSelect: vi.fn() };
    act(() => {
      controller().showToast('책을 휴지통으로 이동했습니다.', 'info', undo);
      controller().showToast('동기화 완료');
      controller().showToast('저장 완료');
      controller().showToast('새 회차 확인');
    });
    expect(controller().toasts.find((toast) => toast.action === undo)?.leaving).not.toBe(true);
    expect(controller().toasts.filter((toast) => !toast.leaving)).toHaveLength(3);
  });

  it('merges repeated messages and caps how many routine toasts stack up', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    });
    const controller = harness();
    act(() => {
      controller().showToast('같은 알림');
      controller().showToast('같은 알림');
    });
    expect(controller().toasts).toHaveLength(1);
    act(() => {
      controller().showToast('오류', 'danger');
      controller().showToast('둘째');
      controller().showToast('셋째');
    });
    const visible = controller().toasts.filter((toast) => !toast.leaving);
    expect(visible.map((toast) => toast.message)).toEqual(['오류', '둘째', '셋째']);
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(controller().toasts).toHaveLength(0);
  });
});
