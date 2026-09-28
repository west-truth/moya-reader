/*
 * Loading placeholders shaped like the content they stand in for. Pair them with a
 * `role="status"` container that names what is loading; the shapes are decorative.
 */

/** Cover-shaped placeholders that match the library grid. */
export function SkeletonCoverGrid({ count = 8 }: { readonly count?: number }) {
  return (
    <div className="skeleton-cover-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="skeleton-cover-card">
          <span className="skeleton skeleton-cover" />
          <span className="skeleton skeleton-line is-wide" />
          <span className="skeleton skeleton-line" />
        </span>
      ))}
    </div>
  );
}

/** Row placeholders for chapter and item lists. */
export function SkeletonRows({ count = 6 }: { readonly count?: number }) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="skeleton-row">
          <span className="skeleton skeleton-line is-index" />
          <span className="skeleton skeleton-line is-wide" />
          <span className="skeleton skeleton-line is-meta" />
        </span>
      ))}
    </div>
  );
}
