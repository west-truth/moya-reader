import { findExtensionUpdates, type Update, type Review } from './extension-updates';
import { useEffect, useRef, useState } from 'react';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import type { SourceExtensionManager } from '../../external-sources/extension-management';
import { packageOperationMessage } from '../../extensions/packages/package-operation-error';

/** Selection queues reviews, never grants trust or new permissions automatically. */
export function ExtensionUpdatesPanel({
  manager,
  suwayomi,
  autoCheck = false,
}: {
  manager: InstalledExtensionManager;
  autoCheck?: boolean;
  suwayomi?: SourceExtensionManager;
}) {
  const [updates, setUpdates] = useState<Update[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [queue, setQueue] = useState<Update[]>([]);
  const [review, setReview] = useState<Review>();
  const held = useRef<Review>();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const operation = useRef<AbortController>();
  useEffect(
    () => () => {
      operation.current?.abort();
      held.current?.discard?.();
    },
    [],
  );
  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    const timer = setTimeout(() => controller.abort(), 150_000);
    setBusy(true);
    setErrors([]);
    try {
      await task(controller.signal);
    } catch (error) {
      setErrors([
        controller.signal.aborted
          ? '작업을 중단했습니다. 설치 여부는 목록에서 다시 확인해 주세요.'
          : (packageOperationMessage(error) ?? '확인하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.'),
      ]);
    } finally {
      clearTimeout(timer);
      if (operation.current === controller) {
        operation.current = undefined;
        setBusy(false);
      }
    }
  };
  const check = () =>
    void run(async (signal) => {
      setMessage('');
      setUpdates([]);
      setSelected([]);
      setChecked(false);
      const result = await findExtensionUpdates(manager, suwayomi, signal);
      setUpdates(result.updates);
      setErrors(result.failures);
      setChecked(true);
    });
  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  });
  useEffect(() => {
    if (!autoCheck) return;
    const timer = setTimeout(() => checkRef.current(), 0);
    return () => clearTimeout(timer);
  }, [autoCheck]);
  const openNext = async (next: Update[], signal: AbortSignal) => {
    setQueue(next);
    setAccepted(false);
    setReview(undefined);
    held.current?.discard?.();
    held.current = undefined;
    if (!next.length) return;
    const prepared = await next[0]!.prepare(signal);
    if (signal.aborted) {
      prepared.discard?.();
      signal.throwIfAborted();
    }
    held.current = prepared;
    setReview(prepared);
  };
  return (
    <section className="settings-section-card source-updates-panel" aria-label="소스 업데이트">
      <h3>소스 업데이트</h3>
      <p>선택한 업데이트를 확인 후 설치합니다.</p>
      <button type="button" disabled={busy || Boolean(review)} onClick={check}>
        업데이트 확인
      </button>
      {busy && (
        <>
          <span role="status">처리 중…</span>
          <button type="button" onClick={() => operation.current?.abort()}>
            작업 중단
          </button>
        </>
      )}
      {errors.map((error) => (
        <p key={error} role="alert">
          {error}
        </p>
      ))}
      {message && <p role="status">{message}</p>}
      {checked && !updates.length && (
        <p>{errors.length ? '일부 소스를 확인하지 못했습니다.' : '새 업데이트가 없습니다.'}</p>
      )}
      {!review &&
        updates.map((update) => (
          <label key={update.id} className="source-update-row">
            <input
              type="checkbox"
              disabled={busy}
              checked={selected.includes(update.id)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked ? [...current, update.id] : current.filter((id) => id !== update.id),
                )
              }
            />
            <span>
              <strong>{update.title}</strong>
              {update.subtitle && <small>{update.subtitle}</small>}
            </span>
          </label>
        ))}
      {!review && selected.length > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run((signal) =>
              openNext(
                updates.filter((update) => selected.includes(update.id)),
                signal,
              ),
            )
          }
        >
          선택 {selected.length}개 순서대로 검토
        </button>
      )}
      {review && (
        <div className="extension-install-confirmation">
          <strong>{review.title}</strong>
          <ul>
            {review.details.map((detail, index) => (
              <li key={index} className="installed-extension-origin">
                {detail}
              </li>
            ))}
          </ul>
          <label>
            <input
              type="checkbox"
              checked={accepted}
              disabled={busy}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            게시자·접근 범위를 확인했고 이 업데이트를 신뢰합니다.
          </label>
          <button
            type="button"
            disabled={busy || !accepted}
            onClick={() =>
              void run(async (signal) => {
                await review.install(signal);
                signal.throwIfAborted();
                const completed = queue[0]!;
                setUpdates((current) => current.filter((item) => item.id !== completed.id));
                setSelected((current) => current.filter((id) => id !== completed.id));
                setMessage(`${review.title} 설치 확인 완료`);
                await openNext(queue.slice(1), signal);
              })
            }
          >
            확인한 업데이트 설치
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              held.current?.discard?.();
              held.current = undefined;
              setReview(undefined);
              setQueue([]);
            }}
          >
            검토 취소
          </button>
        </div>
      )}
    </section>
  );
}
