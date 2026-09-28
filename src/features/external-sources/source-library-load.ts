/** Bound a stalled storage/sync read; its eventual result is ignored by the caller. */
export async function sourceLibraryLoad<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('소스 작품을 불러오는 시간이 초과되었습니다. 다시 시도해 주세요.')),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
