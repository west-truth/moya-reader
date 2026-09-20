import { useState } from 'react';
import type { ReadingProfile, ReadingProfileOverride } from '../../domain/types';

const STORAGE_KEY = 'moya.reader-theme-presets.v1';

interface ReaderThemePreset {
  readonly id: string;
  readonly name: string;
  readonly foreground: string;
  readonly background: string;
  readonly brightness: number;
}

function loadPresets(): ReaderThemePreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ReaderThemePreset =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as ReaderThemePreset).id === 'string' &&
        typeof (item as ReaderThemePreset).name === 'string' &&
        /^#[0-9a-f]{6}$/iu.test((item as ReaderThemePreset).foreground) &&
        /^#[0-9a-f]{6}$/iu.test((item as ReaderThemePreset).background) &&
        typeof (item as ReaderThemePreset).brightness === 'number',
    );
  } catch {
    return [];
  }
}

function storePresets(presets: readonly ReaderThemePreset[]): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
}

export function ReaderThemePresetManager({
  profile,
  foreground,
  background,
  updateProfile,
}: {
  readonly profile: ReadingProfile;
  readonly foreground: string;
  readonly background: string;
  readonly updateProfile: (patch: ReadingProfileOverride) => void;
}) {
  const [presets, setPresets] = useState(loadPresets);
  const [name, setName] = useState('');
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const duplicate = presets.some((preset) => preset.name === name.trim());
  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (duplicate && !window.confirm(`“${trimmed}” 테마의 색상과 밝기를 덮어쓸까요?`)) return;
    const next = [
      ...presets.filter((preset) => preset.name !== trimmed),
      {
        id: `reader-theme-${Date.now().toString(36)}`,
        name: trimmed,
        foreground,
        background,
        brightness: profile.brightness,
      },
    ];
    if (!storePresets(next)) {
      setError(true);
      return;
    }
    setPresets(next);
    setName('');
    setError(false);
  };
  const remove = (id: string) => {
    const next = presets.filter((preset) => preset.id !== id);
    if (!storePresets(next)) {
      setError(true);
      return;
    }
    setPresets(next);
    setError(false);
  };
  return (
    <section className="reader-settings-group">
      <h3>내 리더 테마</h3>
      <p className="field-help">현재 색상과 밝기를 저장합니다.</p>
      <div className="reader-theme-preset-save">
        <label>
          <span className="sr-only">새 리더 테마 이름</span>
          <input
            value={name}
            maxLength={40}
            placeholder="테마 이름"
            aria-label="새 리더 테마 이름"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
            }}
          />
        </label>
        <button type="button" className="ghost-btn" disabled={!name.trim()} onClick={save}>
          {duplicate ? '같은 이름의 테마 덮어쓰기' : '현재 색상 저장'}
        </button>
      </div>
      {error && (
        <p className="reader-settings-inline-error" role="alert">
          이 기기에 테마를 저장하지 못했습니다.
        </p>
      )}
      {presets.length > 0 && (
        <div className="reader-theme-preset-list">
          {presets.map((preset) => (
            <article key={preset.id}>
              {editing === preset.id ? (
                <div className="reader-theme-preset-save">
                  <input
                    aria-label="변경할 테마 이름"
                    value={renameDraft}
                    maxLength={40}
                    onChange={(event) => setRenameDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    disabled={
                      !renameDraft.trim() || presets.some((p) => p.id !== preset.id && p.name === renameDraft.trim())
                    }
                    onClick={() => {
                      const next = presets.map((p) => (p.id === preset.id ? { ...p, name: renameDraft.trim() } : p));
                      if (!storePresets(next)) {
                        setError(true);
                        return;
                      }
                      setPresets(next);
                      setEditing(undefined);
                      setError(false);
                    }}
                  >
                    이름 저장
                  </button>
                  <button type="button" onClick={() => setEditing(undefined)}>
                    취소
                  </button>
                  {presets.some((p) => p.id !== preset.id && p.name === renameDraft.trim()) && (
                    <small role="status">이미 사용 중인 이름입니다.</small>
                  )}
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="reader-theme-preset-apply"
                    onClick={() =>
                      updateProfile({
                        theme: 'custom',
                        foreground: preset.foreground,
                        background: preset.background,
                        brightness: preset.brightness,
                      })
                    }
                  >
                    <span style={{ color: preset.foreground, background: preset.background }}>가</span>
                    <strong>{preset.name}</strong>
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => {
                      setEditing(preset.id);
                      setRenameDraft(preset.name);
                    }}
                  >
                    이름 변경
                  </button>
                  <button type="button" className="ghost-btn" onClick={() => remove(preset.id)}>
                    삭제
                  </button>
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
