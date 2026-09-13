import { useMemo } from 'react';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import { CompatibilityPreferencesPanel } from './CompatibilityPreferencesPanel';

export function InstalledSourcePreferences({
  manager,
  sourceId,
  disabled,
}: {
  manager: InstalledExtensionManager;
  sourceId: string;
  disabled: boolean;
}) {
  const adapter = useMemo(
    () => ({
      preferences: (id: string) => manager.preferences!(id, { action: 'read' }),
      savePreferences: async (
        id: string,
        revision: number,
        changes: Record<string, unknown>,
        privateOrigins: readonly string[],
      ) => {
        await manager.preferences!(id, {
          action: 'save',
          revision,
          changes: changes as Record<string, string | number | boolean | null>,
          privateOrigins,
        });
      },
    }),
    [manager],
  );
  if (!manager.preferences) return null;
  return (
    <details className="installed-source-preferences">
      <summary>확장 옵션</summary>
      <fieldset disabled={disabled}>
        <CompatibilityPreferencesPanel manager={adapter} pkg={sourceId} onSaved={() => undefined} />
      </fieldset>
    </details>
  );
}
