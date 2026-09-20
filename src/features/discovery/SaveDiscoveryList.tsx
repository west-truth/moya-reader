import { useState } from 'react';
import { ModalDrawer } from '../../shared/ui/ModalDrawer';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import type { DiscoveryController } from './useDiscoveryController';
export function SaveDiscoveryList({
  discovery,
  source,
  close,
}: {
  discovery: DiscoveryController;
  source: ExternalSourceController;
  close(): void;
}) {
  const [target, setTarget] = useState(
    discovery.config.tabs.find((t) => !t.hidden)?.id ?? discovery.config.tabs[0]?.id ?? '',
  );
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const browse = source.browse;
  return (
    <ModalDrawer
      open
      title="탐색에 목록 추가"
      onClose={close}
      closeDisabled={saving}
      className="discovery-editor"
      footer={
        <button
          type="button"
          className="primary-btn"
          disabled={saving || !target || !browse || !source.activeSourceId}
          onClick={async () => {
            if (!browse || !source.activeSourceId) return;
            const next = structuredClone(discovery.config);
            const tab = next.tabs.find((t) => t.id === target);
            if (!tab) return;
            if (tab.sections.length >= 60) {
              setError('한 탭에는 목록을 60개까지 추가할 수 있습니다.');
              return;
            }
            tab.sections.push({
              id: crypto.randomUUID(),
              sourceId: source.activeSourceId,
              title: title.trim(),
              mode: browse.activeMode === 'latest' ? 'latest' : 'popular',
              parentRef: source.breadcrumbs.at(-1)?.parentRef,
              filters: (browse.filters ?? []).flatMap((f) =>
                'defaultValue' in f
                  ? [
                      {
                        position: f.position,
                        groupPosition: f.groupPosition,
                        value: source.filterValues[f.id] ?? f.defaultValue,
                      },
                    ]
                  : [],
              ),
              filterSignature: JSON.stringify(browse.filters ?? []),
            });
            setSaving(true);
            try {
              await discovery.save(next, discovery.config);
              close();
            } catch (error) {
              setError(error instanceof Error ? error.message : '저장하지 못했습니다. 다시 시도해 주세요.');
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? '저장 중…' : '추가'}
        </button>
      }
    >
      <fieldset disabled={saving} className="discovery-edit-fields">
        <p>소스와 분류를 저장합니다. 검색어는 제외됩니다.</p>
        <label>
          탭
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {discovery.config.tabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.title}
                {tab.hidden ? ' (숨김)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          목록 이름
          <input
            value={title}
            maxLength={70}
            placeholder="자동으로 이름 지정"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </ModalDrawer>
  );
}
