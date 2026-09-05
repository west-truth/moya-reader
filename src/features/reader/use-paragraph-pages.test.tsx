import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ParagraphPage } from '../../domain/types';
import type { ReaderRepository } from '../../repositories/reader-repository';
import { useParagraphPages, type ParagraphPagesController } from './use-paragraph-pages';

describe('paragraph page failure recovery', () => {
  it.each(['rejected', 'missing'] as const)('waits for an explicit retry after a %s page', async (failure) => {
    let resolve!: (page?: ParagraphPage) => void;
    let reject!: (error: Error) => void;
    const first = new Promise<ParagraphPage | undefined>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    // A regression must fail the assertion rather than create an unbounded test loop.
    const getParagraphPage = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValue(new Promise(() => undefined));
    const repository = { getParagraphPage } as unknown as ReaderRepository;
    let controller!: ParagraphPagesController;
    function Probe() {
      const pages = useParagraphPages(repository, 'chapter-1', 120);
      controller = pages;
      useEffect(() => {
        void pages.loadIndexes([0]).then(() => pages.prune([0]));
      }, [pages]);
      return null;
    }

    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<Probe />);
      });
      await act(async () => {
        if (failure === 'rejected') reject(new Error('HTTP 503'));
        else resolve(undefined);
      });
      expect(controller.isPageFailed(0)).toBe(true);
      expect(getParagraphPage).toHaveBeenCalledTimes(1);

      const paragraph = { id: 'paragraph-1', index: 1, text: '복구된 본문' };
      getParagraphPage.mockResolvedValue({ paragraphs: [paragraph] });
      await act(async () => controller.retryPage(0));
      expect(getParagraphPage).toHaveBeenCalledTimes(2);
      expect(controller.isPageFailed(0)).toBe(false);
      expect(controller.paragraphAt(0)).toEqual(paragraph);
    } finally {
      act(() => renderer?.unmount());
    }
  });
});
