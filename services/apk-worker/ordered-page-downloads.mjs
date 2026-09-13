/** Bounded image IO; page positions never depend on completion order. */
export async function downloadPagesOrdered(pages, concurrency, signal, download) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('invalid_page_concurrency');
  const abort = new AbortController();
  const combined = AbortSignal.any([signal, abort.signal]);
  const result = new Array(pages.length);
  let next = 0;
  let failure;
  let failed = false;
  const lane = async () => {
    try {
      while (next < pages.length) {
        combined.throwIfAborted();
        const index = next++;
        result[index] = await download(pages[index], combined);
        combined.throwIfAborted();
      }
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
      abort.abort(error);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, lane));
  if (failed) throw failure;
  signal.throwIfAborted();
  return result;
}
