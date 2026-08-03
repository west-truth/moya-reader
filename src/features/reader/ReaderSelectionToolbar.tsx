import { AudioLines, StickyNote, X } from 'lucide-react';
import { formatCount } from '../../utils/format';
import type {
  ReaderHighlightColor,
  ReaderLocationSnapshot,
  ReaderScreenHandle,
  ReaderSelection,
} from './reader-screen-contract';

const palette: Array<{ color: ReaderHighlightColor; label: string }> = [
  { color: 'yellow', label: '노랑' },
  { color: 'green', label: '초록' },
  { color: 'blue', label: '파랑' },
  { color: 'pink', label: '분홍' },
];

export function ReaderSelectionToolbar({
  selection,
  location,
  screenHandle,
  onClear,
}: {
  readonly selection: ReaderSelection;
  readonly location?: ReaderLocationSnapshot;
  readonly screenHandle: ReaderScreenHandle;
  readonly onClear: () => void;
}) {
  const actions = screenHandle.getActions();
  return (
    <div className="selection-action-bar" onMouseDown={(event) => event.preventDefault()}>
      <span title={selection.text}>{formatCount(selection.text.length)}자 선택</span>
      <div className="selection-swatch-group" aria-label="선택 문장 하이라이트">
        {palette.map((item) => (
          <button
            key={item.color}
            type="button"
            className={`selection-swatch ${item.color}`}
            onClick={() => {
              if (location) actions.highlightSelection(location, selection, item.color);
              onClear();
            }}
            title={`${item.label} 하이라이트`}
            aria-label={`${item.label} 하이라이트`}
          />
        ))}
      </div>
      <button
        className="mini-icon-btn"
        onClick={() => actions.openSelectionNote(selection)}
        title="선택 문장 메모"
        aria-label="선택 문장 메모"
      >
        <StickyNote size={15} />
      </button>
      <button
        className="mini-icon-btn"
        onClick={() => {
          actions.previewSelectionTTS(selection);
          onClear();
        }}
        title="선택 문장 TTS 미리보기"
        aria-label="선택 문장 TTS 미리보기"
      >
        <AudioLines size={15} />
      </button>
      <button className="mini-icon-btn" onClick={onClear} title="선택 해제" aria-label="선택 해제">
        <X size={15} />
      </button>
    </div>
  );
}
