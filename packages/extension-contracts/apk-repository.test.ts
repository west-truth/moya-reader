import { describe, expect, it } from 'vitest';
import { mangaApkDownloadUrl, mangaApkRepositoryUrl, parseMangaApkIndex } from './apk-repository';
const row = () => ({
  name: 'Manga bundle',
  pkg: 'org.example.manga',
  apk: 'manga-v1.4.6.apk',
  lang: 'ko',
  code: 6,
  version: '1.4.6',
  nsfw: 1,
  sources: [{ name: 'Manga', id: '8502946974566317875', lang: 'ko', baseUrl: 'https://example.org' }],
});
describe('manga APK repositories', () => {
  it('preserves long IDs and image-producing novels inside a mixed factory', () => {
    const input = row();
    input.sources.push({ ...input.sources[0], name: '소설', id: '2' });
    const index = parseMangaApkIndex([input]);
    expect(index.entries[0].sources.map((s) => s.id)).toEqual(['8502946974566317875', '2']);
    expect(index.entries[0].excludedSources).toBe(0);
    expect(index.entries[0].code).toBe(6);
  });
  it('builds a same-directory APK URL for multiple independent repositories', () => {
    const entry = parseMangaApkIndex([row()]).entries[0];
    expect(mangaApkDownloadUrl('https://one.example/repo/index.min.json', entry)).toBe(
      'https://one.example/repo/apk/manga-v1.4.6.apk',
    );
    expect(mangaApkRepositoryUrl('https://two.example/store/')).toBe('https://two.example/store/index.min.json');
  });
  it('rejects ambiguous IDs, duplicate packages and hostile APK paths', () => {
    for (const apk of ['../x.apk', 'https://evil.example/x.apk', 'a%2fb.apk', 'a\\b.apk'])
      expect(() => parseMangaApkIndex([{ ...row(), apk }])).toThrow();
    expect(() => parseMangaApkIndex([row(), row()])).toThrow();
    for (const id of [Number('8502946974566317875'), '9223372036854775808', '-1', '01'])
      expect(() => parseMangaApkIndex([{ ...row(), sources: [{ ...row().sources[0], id }] }])).toThrow();
  });
  it('accepts novel-labelled manga APIs without claiming video API compatibility', () => {
    expect(parseMangaApkIndex([{ ...row(), pkg: 'org.example.novel' }]).entries).toHaveLength(1);
    expect(() => parseMangaApkIndex({ extensions: [row()] })).toThrow();
    for (const url of ['http://example.org', 'https://user:pass@example.org', 'https://example.org/?token=secret'])
      expect(() => mangaApkRepositoryUrl(url)).toThrow();
  });
});
