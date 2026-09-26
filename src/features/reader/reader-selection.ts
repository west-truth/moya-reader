import { useEffect } from 'react';
import type { ReaderSelection } from './reader-screen-contract';

/** Read normalized DOM ranges, including backward drags and split page fragments. */
export function readReaderSelection(root: HTMLElement | null): ReaderSelection | undefined {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return;
  const selected = selection.getRangeAt(0);
  if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) return;
  const parts: Array<{ paragraphId: string; text: string }> = [];
  for (const text of root.querySelectorAll<HTMLElement>('[data-reader-text]')) {
    if (!text.getClientRects().length || !selected.intersectsNode(text)) continue;
    const paragraphId = text.closest<HTMLElement>('[data-paragraph-id]')?.dataset.paragraphId;
    if (!paragraphId) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    if (selected.compareBoundaryPoints(Range.START_TO_START, range) > 0)
      range.setStart(selected.startContainer, selected.startOffset);
    if (selected.compareBoundaryPoints(Range.END_TO_END, range) < 0)
      range.setEnd(selected.endContainer, selected.endOffset);
    const quote = range.toString();
    if (!quote.trim()) continue;
    const previous = parts.at(-1);
    if (previous?.paragraphId === paragraphId) previous.text += quote;
    else parts.push({ paragraphId, text: quote });
  }
  if (!parts.length) return;
  return { paragraphId: parts[0].paragraphId, text: parts.map((part) => part.text).join('\n'), parts };
}

/** Native touch selection handles report selectionchange without mouseup. */
export function useReaderSelectionChanges(
  getSelection: () => ReaderSelection | undefined,
  onChange: (selection?: ReaderSelection) => void,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    const changed = () => onChange(getSelection());
    document.addEventListener('selectionchange', changed);
    return () => document.removeEventListener('selectionchange', changed);
  }, [getSelection, onChange, enabled]);
}
