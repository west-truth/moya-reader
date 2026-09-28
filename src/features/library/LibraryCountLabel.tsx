import { formatCount } from '../../utils/format';

const compact = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 });
const compactLarge = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 0 });
const safeCount = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

/** Bounded one-line cover metadata; the exact value remains available to assistive tech and hover. */
export function LibraryCountLabel({ current, total, unit }: { current: number; total: number; unit: string }) {
  const max = safeCount(total);
  const read = Math.min(safeCount(current), max);
  const exact = `${formatCount(read)} / ${formatCount(max)}${unit}`;
  const short = (value: number) =>
    value >= 100000 ? compactLarge.format(value) : value >= 1000 ? compact.format(value) : String(value);
  return (
    <span className="library-reading-count" title={exact}>
      <span className="sr-only">{exact}</span>
      <span aria-hidden="true">
        {short(read)} / {short(max)}
        {unit === '페이지' ? 'p' : unit}
      </span>
    </span>
  );
}
