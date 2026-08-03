import { ArrowDown, ArrowUp, Check, ImagePlus, Plus, Save, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { BookMetadataPatch } from '@noveldesk/text-core/library-metadata';
import { normalizeCoverImage } from '../../services/cover-image';
import { BookCover } from './BookCover';
import type { CoverDraftAction, LibraryManagementController } from './useLibraryManagementController';

function MetadataEditor({ controller }: { controller: LibraryManagementController }) {
  const book = controller.panel?.kind === 'metadata' ? controller.panel.book : undefined;
  const [title, setTitle] = useState(book?.title ?? '');
  const [author, setAuthor] = useState(book?.author ?? '');
  const [seriesTitle, setSeriesTitle] = useState(book?.seriesTitle ?? '');
  const [seriesIndex, setSeriesIndex] = useState(book?.seriesIndex?.toString() ?? '');
  const [tags, setTags] = useState((book?.tags ?? []).join(', '));
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
      tags: tags.split(',').map((tag) => tag.trim()),
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
        </div>
      </section>

      <section className="metadata-fields">
        <label>
          <span>제목</span>
          <input value={title} maxLength={300} required onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          <span>작가</span>
          <input value={author} maxLength={300} onChange={(event) => setAuthor(event.target.value)} />
        </label>
        <div className="metadata-field-row">
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
        </div>
        <label>
          <span>태그</span>
          <input value={tags} placeholder="쉼표로 구분" onChange={(event) => setTags(event.target.value)} />
        </label>
        <label>
          <span>언어</span>
          <input value={language} placeholder="ko-KR" onChange={(event) => setLanguage(event.target.value)} />
        </label>
        <label>
          <span>설명</span>
          <textarea
            value={description}
            rows={5}
            maxLength={20000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </section>

      {controller.shelves.length > 0 && (
        <section className="metadata-shelf-list">
          <strong>책장</strong>
          {controller.shelves.map((shelf) => (
            <label key={shelf.id}>
              <input
                type="checkbox"
                checked={selectedShelfIds.has(shelf.id)}
                onChange={(event) => {
                  const next = new Set(selectedShelfIds);
                  if (event.target.checked) next.add(shelf.id);
                  else next.delete(shelf.id);
                  setSelectedShelfIds(next);
                }}
              />
              <span className="shelf-color" style={{ backgroundColor: shelf.color }} /> {shelf.name}
            </label>
          ))}
        </section>
      )}
      <footer className="dialog-actions">
        <button className="ghost-btn" type="button" onClick={controller.closePanel}>
          취소
        </button>
        <button
          className="primary-btn"
          type="button"
          disabled={controller.busy || coverBusy || !title.trim()}
          onClick={() => void save()}
        >
          <Save size={16} /> 저장
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

export default function LibraryManagementPanel({ controller }: { controller: LibraryManagementController }) {
  if (!controller.panel) return null;
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && controller.closePanel()}
    >
      <section
        className="modal library-management-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={controller.panel.kind === 'metadata' ? '책 정보 편집' : '책장 관리'}
      >
        <header className="dialog-header">
          <div>
            <h2>{controller.panel.kind === 'metadata' ? '책 정보 편집' : '책장 관리'}</h2>
          </div>
          <button className="icon-btn" onClick={controller.closePanel} aria-label="닫기">
            <X size={18} />
          </button>
        </header>
        {controller.panel.kind === 'metadata' ? (
          <MetadataEditor controller={controller} />
        ) : (
          <ShelfEditor controller={controller} />
        )}
        {controller.error && <p className="dialog-status danger">{controller.error}</p>}
      </section>
    </div>
  );
}
