import type { Novel } from '../../domain/types';
import { formatCount, formatDateTime } from '../../utils/format';
import type { AnnotationScope } from './annotation-contract';
import type { AnnotationViewModel } from './annotation-model';

function markdownQuote(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

export function safeAnnotationDownloadName(value: string): string {
  return (
    value
      // Windows reserves both punctuation and ASCII control characters in file names.
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim()
      .slice(0, 80) || 'annotations'
  );
}

export function buildAnnotationsMarkdown(input: {
  readonly novel: Novel;
  readonly currentChapterTitle?: string;
  readonly scope: AnnotationScope;
  readonly query: string;
  readonly view: AnnotationViewModel;
  readonly exportedAt: string;
}): string {
  const { view } = input;
  const lines = [
    `# ${input.novel.title} 주석`,
    '',
    `- 범위: ${input.scope === 'chapter' ? `현재 화 (${input.currentChapterTitle ?? '-'})` : '전체 책'}`,
    `- 필터: ${input.query.trim() || '없음'}`,
    `- 내보낸 시각: ${formatDateTime(input.exportedAt)}`,
    '',
    `## 북마크 (${formatCount(view.filteredBookmarks.length)})`,
    '',
  ];
  if (view.filteredBookmarks.length === 0) lines.push('- 없음', '');
  for (const bookmark of view.filteredBookmarks) {
    lines.push(
      `- ${view.chapterTitleById.get(bookmark.chapterId) ?? '알 수 없는 화'} · ${bookmark.label} · ${formatDateTime(bookmark.createdAt)}`,
    );
  }
  if (view.filteredBookmarks.length > 0) lines.push('');

  lines.push(`## 하이라이트 (${formatCount(view.filteredHighlights.length)})`, '');
  if (view.filteredHighlights.length === 0) lines.push('- 없음', '');
  for (const highlight of view.filteredHighlights) {
    lines.push(
      `### ${view.chapterTitleById.get(highlight.chapterId) ?? '알 수 없는 화'} · ${formatDateTime(highlight.updatedAt)}`,
      markdownQuote(highlight.quote),
      '',
    );
  }

  lines.push(`## 메모 (${formatCount(view.filteredNotes.length)})`, '');
  if (view.filteredNotes.length === 0) lines.push('- 없음', '');
  for (const note of view.filteredNotes) {
    lines.push(
      `### ${view.chapterTitleById.get(note.chapterId) ?? '알 수 없는 화'} · ${formatDateTime(note.updatedAt)}`,
    );
    if (note.quote) lines.push(markdownQuote(note.quote), '');
    lines.push(note.body, '');
  }
  return `${lines.join('\n').trim()}\n`;
}

export async function copyAnnotationMarkdown(markdown: string): Promise<void> {
  await navigator.clipboard.writeText(markdown);
}

export function downloadAnnotationMarkdown(markdown: string, novelTitle: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeAnnotationDownloadName(novelTitle)}-annotations.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}
