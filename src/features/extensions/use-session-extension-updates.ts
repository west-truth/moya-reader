import { useEffect, useRef } from 'react';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import type { SourceExtensionManager } from '../../external-sources/extension-management';
import type { ToastController } from '../../shared/ui/toast-controller';
import { findExtensionUpdates } from './extension-updates';

/** A fresh app session checks once per package target, without blocking startup. */
export function useSessionExtensionUpdates({
  ready,
  manager,
  suwayomi,
  notify,
  openUpdates,
}: {
  ready: boolean;
  manager?: InstalledExtensionManager;
  suwayomi?: SourceExtensionManager;
  notify: ToastController['showToast'];
  openUpdates(): void;
}) {
  const checked = useRef(new WeakSet<InstalledExtensionManager>());
  const callbacks = useRef({ notify, openUpdates });
  useEffect(() => {
    callbacks.current = { notify, openUpdates };
  }, [notify, openUpdates]);
  useEffect(() => {
    const sessions = checked.current;
    if (!ready || !manager || sessions.has(manager)) return;
    const controller = new AbortController();
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      sessions.add(manager);
      timeout = setTimeout(() => controller.abort(), 150_000);
      void (async () => {
        await manager.refresh();
        controller.signal.throwIfAborted();
        if (!manager.getSnapshot().available) return;
        const { updates } = await findExtensionUpdates(manager, suwayomi, controller.signal);
        controller.signal.throwIfAborted();
        // One installed package may appear in several repositories.
        const count = new Set(updates.map((update) => update.packageKey ?? update.id)).size;
        if (count)
          callbacks.current.notify(`확장 소스 업데이트 ${count}개가 있습니다.`, 'info', {
            label: '확인',
            onSelect: () => callbacks.current.openUpdates(),
          });
      })()
        .catch(() => {
          // Background failures stay silent; the manual check presents actionable errors.
        })
        .finally(() => {
          finished = !controller.signal.aborted;
          clearTimeout(timeout);
        });
    }, 2500);
    return () => {
      clearTimeout(timer);
      clearTimeout(timeout);
      controller.abort();
      if (!finished) sessions.delete(manager);
    };
  }, [ready, manager, suwayomi]);
}
