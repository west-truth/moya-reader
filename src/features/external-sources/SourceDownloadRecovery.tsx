import { useState } from 'react';
import { Download, X } from 'lucide-react';
import type { ExternalSourceController } from './useExternalSourceController';

export function SourceDownloadRecovery({ controller }: { controller: ExternalSourceController }) {
  const [pending, setPending] = useState<string>();
  const queues = controller.recoverableDownloads ?? [];
  if (!queues.length) return null;
  return (
    <details className="source-download-recovery">
      <summary>
        <Download size={16} />
        중단된 다운로드 <strong>{queues.length}</strong>
      </summary>
      <div>
        {queues.map((queue) => (
          <div className="source-download-recovery-row" key={queue.id}>
            <span>
              <strong>{queue.title}</strong>
              <small>남은 {queue.items.length}화</small>
            </span>
            <button
              type="button"
              className="ghost-btn"
              disabled={controller.busy || Boolean(pending)}
              onClick={() => {
                setPending(queue.id);
                void controller.resumeDownloadQueue?.(queue).finally(() => setPending(undefined));
              }}
            >
              {pending === queue.id ? '이어받는 중' : '이어받기'}
            </button>
            <button
              type="button"
              className="icon-btn"
              title={pending === queue.id ? '이어받기 중단' : '대기열에서 제거'}
              aria-label={`${queue.title} ${pending === queue.id ? '이어받기 중단' : '대기열에서 제거'}`}
              disabled={pending !== queue.id && (controller.busy || Boolean(pending))}
              onClick={() => {
                if (pending === queue.id) controller.cancel();
                else void controller.discardDownloadQueue?.(queue.id);
              }}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}
