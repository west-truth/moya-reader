import { Pencil, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UserFontAsset } from '../../domain/types';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import { formatBytes } from '../../utils/format';
import { unloadUserFont } from './user-font-runtime';
import { prepareUserFont, verifyFontCanLoad } from './user-font-service';

export function ReaderUserFontManager({
  repository,
  activeFontId,
  selectFont,
}: {
  readonly repository?: ReaderPersonalizationRepository;
  readonly activeFontId: string;
  selectFont(id: string): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fonts, setFonts] = useState<UserFontAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const refresh = useCallback(() => {
    if (!repository) return Promise.resolve();
    return repository.listUserFonts().then(setFonts);
  }, [repository]);

  useEffect(() => void refresh(), [refresh]);
  if (!repository) return null;

  const install = async (file: File) => {
    setBusy(true);
    setError(undefined);
    try {
      const prepared = await prepareUserFont(file);
      if (fonts.some((font) => font.contentHash === prepared.asset.contentHash)) {
        throw new Error('font_duplicate');
      }
      await verifyFontCanLoad(prepared.asset, prepared.blob);
      await repository.installUserFont(prepared);
      await refresh();
      selectFont(prepared.asset.id);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      setError(
        code === 'font_duplicate'
          ? '이미 등록된 글꼴입니다.'
          : code === 'font_size_invalid'
            ? '글꼴은 10MB 이하만 등록할 수 있습니다.'
            : '유효한 WOFF2, WOFF, TTF 또는 OTF 글꼴인지 확인하세요.',
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="reader-user-fonts">
      <input
        ref={inputRef}
        type="file"
        accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void install(file);
        }}
      />
      <button type="button" className="ghost-btn wide" disabled={busy} onClick={() => inputRef.current?.click()}>
        <Upload size={16} /> {busy ? '글꼴 확인 중' : '내 글꼴 추가'}
      </button>
      {error && <p className="reader-settings-inline-error">{error}</p>}
      {fonts.map((font) => (
        <div key={font.id} className={`reader-user-font-row${activeFontId === font.id ? ' active' : ''}`}>
          <button type="button" className="reader-user-font-select" onClick={() => selectFont(font.id)}>
            <strong>{font.familyLabel}</strong>
            <span>
              {font.style === 'italic' ? '기울임' : '보통'} · {font.weight} · {formatBytes(font.byteLength)}
            </span>
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`${font.familyLabel} 이름 변경`}
            title="이름 변경"
            onClick={() => {
              const familyLabel = window.prompt('글꼴 이름', font.familyLabel)?.trim();
              if (!familyLabel) return;
              void repository.updateUserFont(font.id, { familyLabel, licenseNote: font.licenseNote }).then(refresh);
            }}
          >
            <Pencil size={15} />
          </button>
          <button
            type="button"
            className="icon-btn danger"
            aria-label={`${font.familyLabel} 삭제`}
            title="삭제"
            onClick={() => {
              if (!window.confirm(`'${font.familyLabel}' 글꼴을 삭제할까요?`)) return;
              if (activeFontId === font.id) selectFont('builtin-serif');
              unloadUserFont(font.id);
              void repository.deleteUserFont(font.id).then(refresh);
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
