import { useRef, useState } from 'react';
import type { Shelf } from '../../domain/types';
import { Dialog } from '../../shared/ui/Dialog';

export interface LibraryWorkEdit {
  readonly kind: 'title' | 'shelf';
  readonly title: string;
  readonly shelfId?: string;
  save(value: string): Promise<void>;
}

export function LibraryWorkDialog({
  edit,
  shelves,
  close,
}: {
  edit: LibraryWorkEdit;
  shelves: readonly Shelf[];
  close(): void;
}) {
  const [value, setValue] = useState(edit.kind === 'title' ? edit.title : (edit.shelfId ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const saving = useRef(false);
  return (
    <Dialog
      open
      title={edit.kind === 'title' ? '제목 수정' : '책장 이동'}
      onClose={close}
      closeDisabled={busy}
      className="library-work-dialog"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving.current) return;
          saving.current = true;
          setBusy(true);
          setError(undefined);
          try {
            if (edit.kind === 'shelf' && value && !shelves.some((shelf) => shelf.id === value))
              throw new Error('선택한 책장이 삭제되었습니다. 다른 책장을 선택해 주세요.');
            await edit.save(value.trim());
            close();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : '변경하지 못했습니다. 다시 시도해 주세요.');
          } finally {
            saving.current = false;
            setBusy(false);
          }
        }}
      >
        <label>
          {edit.kind === 'title' ? '작품 제목' : edit.title}
          {edit.kind === 'title' ? (
            <input
              aria-label="작품 제목"
              value={value}
              maxLength={300}
              required
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <select
              aria-label="이동할 책장"
              value={value}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
            >
              <option value="">책장 지정 해제</option>
              {shelves.map((shelf) => (
                <option key={shelf.id} value={shelf.id}>
                  {shelf.name}
                </option>
              ))}
            </select>
          )}
        </label>
        {edit.kind === 'shelf' && <p>선택한 책장으로 옮깁니다. 전체 서재에서도 계속 볼 수 있습니다.</p>}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" className="ghost-btn" disabled={busy} onClick={close}>
            취소
          </button>
          <button type="submit" className="primary-btn" disabled={busy || (edit.kind === 'title' && !value.trim())}>
            {busy ? '저장 중…' : '저장'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
