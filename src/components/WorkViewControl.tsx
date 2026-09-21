import { Grid2X2, Grid3X3, List, AlignJustify } from 'lucide-react';
import { workViews, type WorkView } from './work-view';
import './work-view.css';

export function WorkViewControl({
  value,
  onChange,
  label = '작품 보기 방식',
}: {
  value: WorkView;
  onChange(value: WorkView): void;
  label?: string;
}) {
  const Icon = { grid: Grid2X2, compact: Grid3X3, list: List, text: AlignJustify }[value];
  return (
    <label className="work-view-control">
      <Icon size={17} aria-hidden="true" />
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as WorkView)}>
        {workViews.map(([mode, title]) => (
          <option key={mode} value={mode}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
}
