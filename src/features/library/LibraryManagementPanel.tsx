import { ArrowDown, ArrowUp, Check, Folder, ImagePlus, Plus, Save, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { BookMetadataPatch } from '@noveldesk/text-core/library-metadata';
import { normalizeCoverImage } from '../../services/cover-image';
import { Dialog } from '../../shared/ui/Dialog';
import { BookCover } from './BookCover';
import type { CoverDraftAction, LibraryManagementController } from './useLibraryManagementController';
import { BookEnrichmentInbox } from '../book-enrichment/BookEnrichmentInbox';
import type { BookEnrichmentController } from '../book-enrichment/useBookEnrichmentController';

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function normalizeMetadataTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

export function mayCloseMetadataEditor(dirty: boolean, confirmDiscard?: (message: string) => boolean): boolean {
  return !dirty || (confirmDiscard?.('저장하지 않은 책 정보 변경을 버릴까요?') ?? true);
}

function MetadataEditor({
  controller,
  onDirtyChange,
  onRequestClose,
  bookEnrichment,
}: {
  controller: LibraryManagementController;
  bookEnrichment: BookEnrichmentController;
  onDirtyChange(dirty: boolean): void;
  onRequestClose(): void;
}) {
  const book = controller.panel?.kind === 'metadata' ? controller.panel.book : undefined;
  const [title, setTitle] = useState(book?.title ?? '');
  const [author, setAuthor] = useState(book?.author ?? '');
  const [seriesTitle, setSeriesTitle] = useState(book?.seriesTitle ?? '');
  const [seriesIndex, setSeriesIndex] = useState(book?.seriesIndex?.toString() ?? '');
  const [tags, setTags] = useState(() => normalizeMetadataTags(book?.tags ?? []));
  const [tagDraft, setTagDraft] = useState('');
  const [description, setDescription] = useState(book?.description ?? '');
  const [language, setLanguage] = useState(book?.language ?? '');
  const [fit, setFit] = useState<'crop' | 'contain'>(book?.coverFit ?? 'crop');
  const [positionX, setPositionX] = useState(book?.coverPositionX ?? 50);
  const [positionY, setPositionY] = useState(book?.coverPositionY ?? 50);
  const [cover, setCover] = useState<CoverDraftAction>({ kind: 'keep' });
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState<string>();
  const [selectedShelfIds, setSelectedShelfIds] = useState<Set<string>>(
    () => new Set(controller.memberships.filter((item) => item.bookId === book?.id).map((item) => item.shelfId)),
  );
  const initialShelfIds = useMemo(
    () => new Set(controller.memberships.filter((item) => item.bookId === book?.id).map((item) => item.shelfId)),
    [book?.id, controller.memberships],
  );
  const dirty = Boolean(
    book &&
    (title !== book.title ||
      author !== (book.author ?? '') ||
      seriesTitle !== (book.seriesTitle ?? '') ||
      seriesIndex !== (book.seriesIndex?.toString() ?? '') ||
      tags.join('\u0000') !== normalizeMetadataTags(book.tags ?? []).join('\u0000') ||
      description !== (book.description ?? '') ||
      language !== (book.language ?? '') ||
      fit !== (book.coverFit ?? 'crop') ||
      positionX !== (book.coverPositionX ?? 50) ||
      positionY !== (book.coverPositionY ?? 50) ||
      cover.kind !== 'keep' ||
      !sameIds(initialShelfIds, selectedShelfIds)),
  );

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  useEffect(() => {
    setCover((current) =>
      current.kind === 'replace'
        ? { kind: 'replace', input: { ...current.input, fit, positionX, positionY } }
        : current,
    );
  }, [fit, positionX, positionY]);

  const previewUrl = useMemo(
    () => (cover.kind === 'replace' ? URL.createObjectURL(cover.input.blob) : undefined),
    [cover],
  );
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );
  if (!book) return null;

  const selectCover = async (file?: File) => {
    if (!file) return;
    setCoverBusy(true);
    setCoverError(undefined);
    try {
      setCover({ kind: 'replace', input: await normalizeCoverImage(file, { fit, positionX, positionY }) });
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : '표지를 처리하지 못했습니다.');
    } finally {
      setCoverBusy(false);
    }
  };

  const save = async () => {
    const numericSeriesIndex = seriesIndex.trim() ? Number(seriesIndex) : null;
    const patch: BookMetadataPatch = {
      title,
      author: author || null,
      seriesTitle: seriesTitle || null,
      seriesIndex: numericSeriesIndex,
      tags,
      description: description || null,
      language: language || null,
      coverFit: fit,
      coverPositionX: positionX,
      coverPositionY: positionY,
    };
    const previous = new Set(
      controller.memberships
        .filter((membership) => membership.bookId === book.id)
        .map((membership) => membership.shelfId),
    );
    for (const shelf of controller.shelves) {
      const included = selectedShelfIds.has(shelf.id);
      if (included !== previous.has(shelf.id)) await controller.setMembership(shelf.id, book.id, included);
    }
    await controller.saveBookDetails(book, patch, cover);
  };

  const addTag = () => {
    const additions = tagDraft.split(',');
    const next = normalizeMetadataTags([...tags, ...additions]);
    setTagDraft('');
    if (next.length === tags.length) return;
    setTags(next);
  };

  const toggleShelf = (shelfId: string) => {
    const next = new Set(selectedShelfIds);
    if (next.has(shelfId)) next.delete(shelfId);
    else next.add(shelfId);
    setSelectedShelfIds(next);
  };

  return (
    <div className="library-management-body metadata-editor">
      <section className="metadata-cover-editor">
        <div className="metadata-cover-preview">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="선택한 표지 미리보기"
              style={{
                objectFit: fit === 'contain' ? 'contain' : 'cover',
                objectPosition: `${positionX}% ${positionY}%`,
              }}
            />
          ) : cover.kind === 'remove' ? (
            <div className={`book-cover cover-${(book.coverSeed % 6) + 1}`}>
              <span>{title || book.title}</span>
            </div>
          ) : (
            <BookCover novel={book} className={`book-cover cover-${(book.coverSeed % 6) + 1}`} />
          )}
        </div>
        <div className="metadata-cover-controls">
          <label className="ghost-btn cover-file-button">
            <ImagePlus size={16} /> 표지 선택
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={controller.busy || coverBusy}
              onChange={(event) => void selectCover(event.target.files?.[0])}
            />
          </label>
          {(book.coverAssetId || cover.kind === 'replace') && (
            <button className="ghost-btn danger" type="button" onClick={() => setCover({ kind: 'remove' })}>
              <Trash2 size={16} /> 제거
            </button>
          )}
          <div className="segmented" role="group" aria-label="표지 맞춤 방식">
            <button type="button" className={fit === 'crop' ? 'active' : ''} onClick={() => setFit('crop')}>
              채우기
            </button>
            <button type="button" className={fit === 'contain' ? 'active' : ''} onClick={() => setFit('contain')}>
              원본 비율
            </button>
          </div>
          <label>
            가로 위치{' '}
            <input
              type="range"
              min="0"
              max="100"
              value={positionX}
              onChange={(event) => setPositionX(Number(event.target.value))}
            />
          </label>
          <label>
            세로 위치{' '}
            <input
              type="range"
              min="0"
              max="100"
              value={positionY}
              onChange={(event) => setPositionY(Number(event.target.value))}
            />
          </label>
          {coverError && <p className="field-help warning">{coverError}</p>}
          <p className="metadata-cover-help">JPG, PNG, WEBP · 표시 위치와 맞춤 방식은 책장과 뷰어에 함께 적용됩니다.</p>
        </div>
      </section>

      <div className="metadata-fields">
        <BookEnrichmentInbox
          book={book}
          controller={bookEnrichment}
          manualDraftDirty={dirty}
          onApplied={controller.closePanel}
        />
        <section className="metadata-section metadata-basic-section">
          <div className="metadata-section-heading">
            <h2>기본 정보</h2>
            <p>책장과 작품 상세에 표시될 정보를 수정합니다.</p>
          </div>
          <div className="metadata-basic-grid">
            <label>
              <span>제목</span>
              <input value={title} maxLength={300} required onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              <span>작가</span>
              <input value={author} maxLength={300} onChange={(event) => setAuthor(event.target.value)} />
            </label>
            <label>
              <span>시리즈</span>
              <input value={seriesTitle} maxLength={300} onChange={(event) => setSeriesTitle(event.target.value)} />
            </label>
            <label>
              <span>권</span>
              <input
                type="number"
                min="0"
                step="0.1"
                value={seriesIndex}
                onChange={(event) => setSeriesIndex(event.target.value)}
              />
            </label>
            <label>
              <span>언어</span>
              <input value={language} placeholder="ko-KR" onChange={(event) => setLanguage(event.target.value)} />
            </label>
            <label className="metadata-wide-field">
              <span>설명</span>
              <textarea
                value={description}
                rows={5}
                maxLength={20000}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
          </div>
        </section>

        <section className="metadata-section">
          <div className="metadata-section-heading">
            <h2>태그</h2>
            <p>검색과 정리에 사용할 태그를 추가하세요.</p>
          </div>
          {tags.length > 0 && (
            <div className="metadata-tag-list" aria-label="등록된 태그">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="metadata-tag-chip"
                  onClick={() => setTags(tags.filter((item) => item !== tag))}
                >
                  <span>#{tag}</span>
                  <X size={13} aria-hidden="true" />
                  <span className="sr-only">{tag} 태그 제거</span>
                </button>
              ))}
            </div>
          )}
          <div className="metadata-tag-input-row">
            <input
              value={tagDraft}
              maxLength={80}
              placeholder="태그 입력"
              aria-label="추가할 태그"
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                addTag();
              }}
            />
            <button className="ghost-btn" type="button" disabled={!tagDraft.trim()} onClick={addTag}>
              <Plus size={15} /> 추가
            </button>
          </div>
        </section>

        {controller.shelves.length > 0 && (
          <section className="metadata-section">
            <div className="metadata-section-heading">
              <h2>책장 · 컬렉션</h2>
              <p>이 작품을 둘 책장을 모두 선택할 수 있습니다.</p>
            </div>
            <div className="metadata-shelf-options">
              {controller.shelves.map((shelf) => {
                const selected = selectedShelfIds.has(shelf.id);
                return (
                  <button
                    key={shelf.id}
                    type="button"
                    className={selected ? 'is-selected' : ''}
                    aria-pressed={selected}
                    onClick={() => toggleShelf(shelf.id)}
                  >
                    <Folder size={16} aria-hidden="true" />
                    <span className="shelf-color" style={{ backgroundColor: shelf.color }} />
                    <span>{shelf.name}</span>
                    {selected && <Check size={15} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
      <footer className="dialog-actions">
        <button className="ghost-btn" type="button" onClick={onRequestClose}>
          취소
        </button>
        <button
          className="primary-btn"
          type="button"
          disabled={controller.busy || coverBusy || !title.trim()}
          onClick={() => void save()}
        >
          <Save size={16} /> 변경 사항 저장
        </button>
      </footer>
    </div>
  );
}

function ShelfEditor({ controller }: { controller: LibraryManagementController }) {
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#4f7d65');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const moveShelf = async (index: number, direction: -1 | 1) => {
    const shelf = controller.shelves[index];
    const adjacent = controller.shelves[index + direction];
    if (!shelf || !adjacent) return;
    await controller.updateShelf(shelf, { sortOrder: adjacent.sortOrder });
    await controller.updateShelf(adjacent, { sortOrder: shelf.sortOrder });
  };
  return (
    <div className="library-management-body shelf-editor">
      <div className="shelf-create-row">
        <input
          value={newName}
          maxLength={80}
          placeholder="새 책장 이름"
          onChange={(event) => setNewName(event.target.value)}
        />
        <input
          type="color"
          value={newColor}
          aria-label="새 책장 색상"
          onChange={(event) => setNewColor(event.target.value)}
        />
        <button
          className="primary-btn"
          disabled={!newName.trim() || controller.busy}
          onClick={() => void controller.createShelf(newName, newColor).then(() => setNewName(''))}
        >
          <Plus size={16} /> 추가
        </button>
      </div>
      <div className="shelf-editor-list">
        {controller.shelves.map((shelf, index) => (
          <div className="shelf-editor-row" key={shelf.id}>
            <span className="shelf-color" style={{ backgroundColor: shelf.color }} />
            <input
              value={drafts[shelf.id] ?? shelf.name}
              onChange={(event) => setDrafts({ ...drafts, [shelf.id]: event.target.value })}
            />
            <button
              className="icon-btn"
              title="책장 이름 저장"
              aria-label={`${shelf.name} 이름 저장`}
              onClick={() => void controller.updateShelf(shelf, { name: drafts[shelf.id] ?? shelf.name })}
            >
              <Check size={17} />
            </button>
            <button
              className="icon-btn"
              disabled={index === 0 || controller.busy}
              title="위로 이동"
              aria-label={`${shelf.name} 위로 이동`}
              onClick={() => void moveShelf(index, -1)}
            >
              <ArrowUp size={17} />
            </button>
            <button
              className="icon-btn"
              disabled={index === controller.shelves.length - 1 || controller.busy}
              title="아래로 이동"
              aria-label={`${shelf.name} 아래로 이동`}
              onClick={() => void moveShelf(index, 1)}
            >
              <ArrowDown size={17} />
            </button>
            <button
              className="icon-btn danger"
              title="책장 삭제"
              aria-label={`${shelf.name} 삭제`}
              onClick={() => void controller.deleteShelf(shelf)}
            >
              <Trash2 size={17} />
            </button>
          </div>
        ))}
        {controller.shelves.length === 0 && <p className="field-help">사용자 책장이 없습니다.</p>}
      </div>
    </div>
  );
}

export default function LibraryManagementPanel({
  controller,
  bookEnrichment,
}: {
  controller: LibraryManagementController;
  bookEnrichment: BookEnrichmentController;
}) {
  const [metadataDirty, setMetadataDirty] = useState(false);
  useEffect(() => setMetadataDirty(false), [controller.panel]);
  if (!controller.panel) return null;
  const requestClose = () => {
    if (controller.panel?.kind === 'metadata' && !mayCloseMetadataEditor(metadataDirty, controller.confirmDiscard))
      return;
    controller.closePanel();
  };
  return (
    <Dialog
      open
      title={controller.panel.kind === 'metadata' ? '작품 정보 편집' : '책장 관리'}
      onClose={requestClose}
      className="library-management-dialog"
      backdropClassName="library-management-backdrop"
      closeLabel="닫기"
      closeDisabled={controller.busy}
    >
      {controller.panel.kind === 'metadata' ? (
        <MetadataEditor
          key={controller.panel.book.id}
          controller={controller}
          bookEnrichment={bookEnrichment}
          onDirtyChange={setMetadataDirty}
          onRequestClose={requestClose}
        />
      ) : (
        <ShelfEditor controller={controller} />
      )}
      {controller.error && <p className="dialog-status danger">{controller.error}</p>}
    </Dialog>
  );
}
