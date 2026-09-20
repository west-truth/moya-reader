import { useState } from 'react';
import { ModalDrawer } from '../../shared/ui/ModalDrawer';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import { move, newTab, type DiscoveryConfig } from './discovery-config';

export function DiscoveryEditor({
  config,
  sources,
  save,
  close,
}: {
  config: DiscoveryConfig;
  sources: readonly ExternalSourceView[];
  save(value: DiscoveryConfig): void;
  close(): void;
}) {
  const [draft, setDraft] = useState<DiscoveryConfig>(() => structuredClone(config));
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<DiscoveryConfig>();
  const update = (fn: (draft: DiscoveryConfig) => void) =>
    setDraft((current) => {
      const next = structuredClone(current);
      fn(next);
      return next;
    });
  return (
    <ModalDrawer
      open
      title="탐색 편집"
      onClose={close}
      closeLabel="탐색 편집 닫기"
      className="discovery-editor"
      footer={
        <>
          <button type="button" className="ghost-btn" onClick={close}>
            취소
          </button>
          <button
            type="button"
            className="primary-btn"
            onClick={() => {
              if (!draft.tabs.some((t) => !t.hidden) || draft.tabs.some((t) => !t.title.trim())) {
                setError('이름이 있는 탭을 하나 이상 표시해 주세요.');
                return;
              }
              try {
                save(draft);
                close();
              } catch {
                setError('설정을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.');
              }
            }}
          >
            저장
          </button>
        </>
      }
    >
      <p>이 기기의 탐색 구성입니다. 같은 소스를 여러 탭이나 목록에 넣을 수 있습니다.</p>
      <button
        type="button"
        className="ghost-btn"
        onClick={() => {
          setUndo(structuredClone(draft));
          const connected = sources.filter((s) => s.kind === 'catalog' && s.connection.state === 'connected');
          const templates = [newTab('만화'), newTab('소설'), newTab('웹툰')];
          templates[0]!.sections = connected
            .filter((s) => s.contentKind !== 'text')
            .slice(0, 4)
            .map((s) => ({ id: crypto.randomUUID(), sourceId: s.id, mode: 'popular', title: '' }));
          templates[1]!.sections = connected
            .filter((s) => s.contentKind === 'text')
            .slice(0, 4)
            .map((s) => ({ id: crypto.randomUUID(), sourceId: s.id, mode: 'popular', title: '' }));
          setDraft({ version: 1, tabs: templates });
        }}
      >
        연결된 소스로 추천 구성 만들기
      </button>
      {error && <p role="alert">{error}</p>}
      {undo && (
        <button
          type="button"
          onClick={() => {
            setDraft(undo);
            setUndo(undefined);
          }}
        >
          변경 되돌리기
        </button>
      )}
      {draft.tabs.map((tab, index) => (
        <section className="discovery-editor-tab" key={tab.id} aria-label={`${tab.title} 탭 편집`}>
          <div
            className="discovery-editor-heading"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const from = draft.tabs.findIndex((t) => t.id === event.dataTransfer.getData('text/moya-tab'));
              if (from >= 0)
                update((d) => {
                  d.tabs = move(d.tabs, from, index - from);
                });
            }}
          >
            <button
              type="button"
              draggable
              aria-label={`${tab.title} 탭 순서 끌기`}
              title="드래그하거나 옆의 위·아래 버튼으로 순서를 바꿀 수 있습니다"
              onDragStart={(event) => event.dataTransfer.setData('text/moya-tab', tab.id)}
            >
              ↕
            </button>
            <label>
              탭 이름
              <input
                value={tab.title}
                maxLength={40}
                onChange={(e) =>
                  update((d) => {
                    d.tabs[index]!.title = e.target.value;
                  })
                }
              />
            </label>
            <button
              type="button"
              aria-label={`${tab.title} 탭 위로`}
              disabled={index === 0}
              onClick={() =>
                update((d) => {
                  d.tabs = move(d.tabs, index, -1);
                })
              }
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`${tab.title} 탭 아래로`}
              disabled={index === draft.tabs.length - 1}
              onClick={() =>
                update((d) => {
                  d.tabs = move(d.tabs, index, 1);
                })
              }
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => {
                setUndo(structuredClone(draft));
                update((d) => {
                  d.tabs.splice(index, 1);
                });
              }}
            >
              탭 삭제
            </button>
          </div>
          <div className="discovery-editor-heading">
            <label>
              <input
                type="checkbox"
                checked={!tab.hidden}
                onChange={(e) =>
                  update((d) => {
                    d.tabs[index]!.hidden = !e.target.checked;
                  })
                }
              />
              표시
            </label>
            <label>
              표시 밀도
              <select
                value={tab.density}
                onChange={(e) =>
                  update((d) => {
                    d.tabs[index]!.density = e.target.value as 'comfortable' | 'compact';
                  })
                }
              >
                <option value="comfortable">여유롭게</option>
                <option value="compact">촘촘하게</option>
              </select>
            </label>
          </div>
          {tab.sections.map((section, sectionIndex) => (
            <div
              key={section.id}
              className="discovery-editor-section"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const from = tab.sections.findIndex(
                  (row) => row.id === event.dataTransfer.getData('text/moya-section'),
                );
                if (from >= 0)
                  update((d) => {
                    d.tabs[index]!.sections = move(d.tabs[index]!.sections, from, sectionIndex - from);
                  });
              }}
            >
              <label>
                소스
                <select
                  aria-label="목록 소스"
                  value={section.sourceId}
                  onChange={(e) =>
                    update((d) => {
                      const row = d.tabs[index]!.sections[sectionIndex]!;
                      row.sourceId = e.target.value;
                      delete row.filters;
                      delete row.filterSignature;
                      delete row.parentRef;
                    })
                  }
                >
                  {!sources.some((s) => s.id === section.sourceId) && (
                    <option value={section.sourceId}>사용할 수 없는 소스</option>
                  )}
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                목록
                <select
                  value={section.mode}
                  onChange={(e) =>
                    update((d) => {
                      d.tabs[index]!.sections[sectionIndex]!.mode = e.target.value as 'popular' | 'latest';
                    })
                  }
                >
                  <option value="popular">인기</option>
                  <option value="latest">최신 업데이트</option>
                </select>
              </label>
              <label>
                목록 이름
                <input
                  value={section.title}
                  placeholder="소스 이름과 목록 종류로 표시"
                  maxLength={70}
                  onChange={(e) =>
                    update((d) => {
                      d.tabs[index]!.sections[sectionIndex]!.title = e.target.value;
                    })
                  }
                />
              </label>
              {section.filters?.length ? <span>저장한 분류 적용 중</span> : null}
              <div className="discovery-editor-heading">
                <button
                  type="button"
                  draggable
                  aria-label="목록 순서 끌기"
                  title="드래그하거나 위·아래 버튼으로 이동"
                  onDragStart={(event) => {
                    event.stopPropagation();
                    event.dataTransfer.setData('text/moya-section', section.id);
                  }}
                >
                  ↕
                </button>
                <button
                  type="button"
                  aria-label="목록 위로"
                  disabled={!sectionIndex}
                  onClick={() =>
                    update((d) => {
                      d.tabs[index]!.sections = move(tab.sections, sectionIndex, -1);
                    })
                  }
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label="목록 아래로"
                  disabled={sectionIndex === tab.sections.length - 1}
                  onClick={() =>
                    update((d) => {
                      d.tabs[index]!.sections = move(tab.sections, sectionIndex, 1);
                    })
                  }
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUndo(structuredClone(draft));
                    update((d) => {
                      d.tabs[index]!.sections.splice(sectionIndex, 1);
                    });
                  }}
                >
                  목록 삭제
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="ghost-btn"
            disabled={!sources.length || tab.sections.length >= 60}
            onClick={() =>
              update((d) => {
                d.tabs[index]!.sections.push({
                  id: crypto.randomUUID(),
                  sourceId: (sources.find(
                    (source) => source.connection.state === 'connected' && source.kind === 'catalog',
                  ) ?? sources[0])!.id,
                  mode: 'popular',
                  title: '',
                });
              })
            }
          >
            목록 추가
          </button>
        </section>
      ))}
      <button
        type="button"
        className="primary-btn"
        disabled={draft.tabs.length >= 30}
        onClick={() =>
          update((d) => {
            d.tabs.push(newTab());
          })
        }
      >
        탭 추가
      </button>
      <p>인기·최신·분류는 소스가 제공하는 범위에서 표시됩니다. 탭 삭제는 다운로드나 설치된 소스를 삭제하지 않습니다.</p>
    </ModalDrawer>
  );
}
