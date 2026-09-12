/** Shared static assets follow the build's mount path, including GitHub project Pages. */
export function publicAssetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;
}
