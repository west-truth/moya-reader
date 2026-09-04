import { LoaderCircle, Plus } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Dialog } from '../../shared/ui/Dialog';
import type { ImportFeatureController } from './useImportController';

const ImportDialog = lazy(() => import('./ImportDialog'));

export interface ImportFeatureHostProps {
  controller: ImportFeatureController;
  showFloatingTrigger: boolean;
}

export function ImportFeatureHost({ controller, showFloatingTrigger }: ImportFeatureHostProps) {
  return (
    <>
      {controller.isOpen && (
        <Suspense
          fallback={
            <Dialog
              open
              title="책 가져오기"
              onClose={controller.close}
              closeLabel="가져오기 닫기"
              className="import-dialog"
            >
              <p className="muted" aria-live="polite">
                가져오기 화면을 준비하고 있습니다.
              </p>
            </Dialog>
          }
        >
          <ImportDialog controller={controller} />
        </Suspense>
      )}
      {showFloatingTrigger && (
        <button
          className={`floating-import${controller.tasks.length > 0 ? ' is-active' : ''}`}
          onClick={controller.open}
          title={controller.tasks.length > 0 ? '가져오기 진행 상태' : '책 가져오기'}
          aria-label={controller.tasks.length > 0 ? `가져오기 ${controller.tasks.length}개 진행 상태` : '책 가져오기'}
        >
          {controller.tasks.length > 0 ? <LoaderCircle size={24} className="spin" /> : <Plus size={24} />}
        </button>
      )}
    </>
  );
}
