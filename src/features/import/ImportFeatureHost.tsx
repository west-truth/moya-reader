import { Plus } from 'lucide-react';
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
        <button className="floating-import" onClick={controller.open} title="책 가져오기" aria-label="책 가져오기">
          <Plus size={24} />
        </button>
      )}
    </>
  );
}
