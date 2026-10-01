/** Visible pages first, then nearby pages in both directions; never request an entire episode. */
export function streamImageWindow(
  visible: readonly number[],
  current: number,
  total: number,
  radius: number,
): number[] {
  const valid = (index: number) => Number.isInteger(index) && index >= 0 && index < total;
  const shown = [...new Set(visible.filter(valid))];
  if (!shown.length && valid(current)) shown.push(current);
  if (!shown.length) return [];
  const wanted = new Set([current, ...shown].filter(valid));
  const start = Math.min(...shown);
  const end = Math.max(...shown);
  const count = Number.isFinite(radius) ? Math.min(10, Math.max(0, Math.floor(radius))) : 0;
  for (let distance = 1; distance <= count; distance++) {
    if (valid(end + distance)) wanted.add(end + distance);
    if (valid(start - distance)) wanted.add(start - distance);
  }
  return [...wanted];
}
