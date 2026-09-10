import React, { useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ReaderViewport } from '../../src/features/reader/ReaderViewport.tsx';
import { ReaderScreenHandle } from '../../src/features/reader/reader-screen-contract.ts';
import { defaultSettings } from '../../src/repositories/reader-defaults.ts';
import { PARAGRAPHS_PER_PAGE } from '../../src/repositories/reader-defaults.ts';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/reader-shell.css';
import '../../src/styles/reader-content.css';

const singleParagraph = new URLSearchParams(location.search).has('single');
const variableParagraphs = new URLSearchParams(location.search).has('variable');
const longChapter = new URLSearchParams(location.search).has('long');
const withNextChapter = new URLSearchParams(location.search).has('next');
const shortParagraphs = new URLSearchParams(location.search).has('short');
const chapter = {
  id: `position-chapter-${singleParagraph ? 1 : 120}`,
  novelId: 'position-book',
  index: 1,
  title: 'Synthetic reader',
  paragraphCount: singleParagraph ? 1 : longChapter ? 12000 : 120,
  textHash: 'fixture',
};
const novel = {
  id: 'position-book',
  title: 'Synthetic',
  totalChapters: 1,
  activeContentRevisionId: `position-revision-${chapter.paragraphCount}`,
  format: 'txt',
};
let offset = 0;
const paragraphs = Array.from({ length: chapter.paragraphCount }, (_, index) => {
  const text =
    `문단 ${index + 1}. ` +
    '이것은 독서 위치를 확인하기 위한 합성 본문입니다. '.repeat(
      shortParagraphs ? 0 : singleParagraph ? 80 : variableParagraphs ? 1 + (index % 12) : 5,
    );
  const startOffsetInChapter = offset;
  offset += text.length;
  return {
    id: `p${index}`,
    novelId: novel.id,
    chapterId: chapter.id,
    index: index + 1,
    text,
    startOffsetInChapter,
    endOffsetInChapter: offset,
    textHash: `p${index}`,
  };
});
const writes = [];
const observations = { reveals: 0, openedChapters: [] };
const pageRequests = [];
let pausePages = false;
let pendingPages = [];
const noop = () => {};
const screenHandle = new ReaderScreenHandle();
screenHandle.setActions(
  new Proxy(
    {},
    { get: (_, key) => (key === 'openChapter' ? (chapter) => observations.openedChapters.push(chapter.id) : noop) },
  ),
);
const repository = {
  getParagraphPage: async (_, pageIndex) => {
    pageRequests.push(pageIndex);
    if (pausePages) await new Promise((resolve) => pendingPages.push(resolve));
    return { paragraphs: paragraphs.slice(pageIndex * PARAGRAPHS_PER_PAGE, (pageIndex + 1) * PARAGRAPHS_PER_PAGE) };
  },
  getParagraph: async (id) => paragraphs.find((paragraph) => paragraph.id === id),
  saveReadingPosition: async (position) => writes.push({ ...position, activeFlow: globalThis.readerFixture?.flow }),
};
function Fixture() {
  const [flow, setFlow] = useState('scroll');
  const apiRef = useRef();
  globalThis.readerFixture = {
    setFlow,
    flow,
    api: () => apiRef.current,
    writes,
    observations,
    pageRequests,
    pausePages: () => {
      pausePages = true;
    },
    resumePages: () => {
      pausePages = false;
      const pending = pendingPages;
      pendingPages = [];
      pending.forEach((resolve) => resolve());
    },
  };
  const style = {
    '--reading-font-size': '20px',
    '--reading-font-weight': 400,
    '--reading-line-height': 1.8,
    '--reading-width': '740px',
    '--reading-margin-x': '40px',
    '--reading-margin-y': '64px',
    '--reading-paragraph-spacing': '16px',
  };
  return React.createElement(
    'main',
    { className: 'reader-screen', style },
    React.createElement(ReaderViewport, {
      repository,
      novel,
      chapter,
      chapters: withNextChapter
        ? [chapter, { ...chapter, id: 'next-chapter', index: 2, title: 'Next chapter' }]
        : [chapter],
      settings: defaultSettings,
      readingFlow: flow,
      mode: 'read',
      search: { highlightQuery: '' },
      screenHandle,
      apiRef,
      onApiReady: noop,
      onVisualLocation: noop,
      onSelectionChanged: noop,
      onRevealChrome: () => {
        observations.reveals += 1;
      },
      onToggleImmersive: noop,
      onPageIntent: () => setFlow('paginated'),
      onScrollIntent: () => setFlow('scroll'),
      onDocumentLink: noop,
    }),
  );
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
