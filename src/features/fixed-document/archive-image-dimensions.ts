import type { ContinuousImageDimensions } from './continuous-scroll';

/** Resolve geometry before displaying a newly loaded image in the episode flow. */
export async function archiveImageDimensions(blob: Blob, signal: AbortSignal): Promise<ContinuousImageDimensions> {
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  const image = new Image();
  const cancel = () => {
    image.src = '';
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    signal.removeEventListener('abort', cancel);
    image.src = '';
    URL.revokeObjectURL(url);
  }
}
