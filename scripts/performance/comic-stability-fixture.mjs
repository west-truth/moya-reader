import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import FixedDocumentScreen from '../../src/features/fixed-document/FixedDocumentScreen.tsx';
import { IndexedDbComicReadingProfileRepository } from '../../src/storage/comic-reading-profile-store.ts';
import { DEFAULT_COMIC_READING_PROFILE } from '../../src/features/fixed-document/comic-layout.ts';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';

const legacy = new URLSearchParams(location.search).has('legacy');
const seamless = !new URLSearchParams(location.search).has('gapped');
const sectionSize = new URLSearchParams(location.search).has('long-comic') ? 200 : 40;
let delay = 0;
let failedPage = -1;
let assetVersion = 0;
const requests = [];
const repository = {
  getParagraphPage: async (id) => ({ paragraphs: [{ assetId: `${id}:${assetVersion}`, documentPageType: 'body' }] }),
};
const assets = {
  getEmbeddedResource: async (_, id, signal) => {
    requests.push(id);
    await new Promise((resolve) => setTimeout(resolve, delay));
    signal?.throwIfAborted();
    const index = Number(id.split(':')[0].slice(1));
    if (index === failedPage) throw new Error('Injected image failure');
    const height = 600 + (index % 7) * 500;
    return {
      blob: new Blob(
        [
          `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${height}"><rect width="600" height="${height}" fill="teal"/><text x="60" y="120" fill="white" font-size="80">${id}</text></svg>`,
        ],
        { type: 'image/svg+xml' },
      ),
    };
  },
};
const noop = () => {};
function Fixture() {
  const [count, setCount] = useState(sectionSize * 2);
  const [version, setVersion] = useState(0);
  const chapters = useMemo(
    () =>
      Array.from({ length: count }, (_, index) => ({
        id: `p${index}`,
        index: index + 1,
        title: `page ${index}`,
        novelId: 'comic-review',
        paragraphCount: 1,
        textHash: `title-${index}`,
        documentSectionId: `s${Math.floor(index / sectionSize)}`,
        documentSectionTitle: `section ${Math.floor(index / sectionSize)}`,
        ...(!legacy ? { documentSectionSourceContentHash: `hash${Math.floor(index / sectionSize)}:${version}` } : {}),
      })),
    [count, version],
  );
  globalThis.comicFixture = {
    setCount,
    failPage: (index) => {
      failedPage = index;
    },
    requests,
    setDelay: (value) => {
      delay = value;
    },
    replace: () => {
      assetVersion++;
      setVersion(assetVersion);
    },
  };
  return React.createElement(FixedDocumentScreen, {
    novel: {
      id: 'comic-review',
      title: 'Synthetic comic',
      sourceFileName: 'comic.cbz',
      format: 'image_archive',
      activeContentRevisionId: `revision${count}:${version}`,
      rawTextHash: 'hash',
      totalChapters: count,
    },
    chapters,
    repository,
    assets,
    initialChapterId: `p${Number(new URLSearchParams(location.search).get('start') ?? 0)}`,
    onBack: noop,
    onPageSettled: noop,
  });
}
async function main() {
  await new IndexedDbComicReadingProfileRepository().save('comic-review', {
    ...DEFAULT_COMIC_READING_PROFILE,
    mode: 'vertical',
    seamlessVertical: seamless,
    fit: 'width',
  });
  createRoot(document.getElementById('root')).render(React.createElement(Fixture));
}
void main();
