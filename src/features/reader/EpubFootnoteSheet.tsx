import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { Paragraph } from '../../domain/types';

export interface EpubFootnoteSheetProps {
  readonly paragraphs: readonly Paragraph[];
  readonly onClose: () => void;
  readonly onOpenInDocument: () => void;
}

export function EpubFootnoteSheet({ paragraphs, onClose, onOpenInDocument }: EpubFootnoteSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="reader-footnote-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="reader-footnote-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reader-footnote-title"
      >
        <header>
          <div>
            <span>EPUB</span>
            <h2 id="reader-footnote-title">각주</h2>
          </div>
          <button ref={closeRef} type="button" className="mini-icon-btn" onClick={onClose} aria-label="각주 닫기">
            <X size={18} />
          </button>
        </header>
        <div className="reader-footnote-body">
          {paragraphs.map((paragraph) => (
            <p key={paragraph.id}>{paragraph.text}</p>
          ))}
        </div>
        <footer>
          <button type="button" className="ghost-btn" onClick={onOpenInDocument}>
            본문에서 보기
          </button>
          <button type="button" className="primary-btn" onClick={onClose}>
            닫기
          </button>
        </footer>
      </section>
    </div>
  );
}
