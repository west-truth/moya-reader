import { Check, Cloud, CloudOff, Link, Link2Off, LoaderCircle, PlugZap, ShieldCheck, Star } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { ExternalSourceConnectionForm } from '../../external-sources/contracts';
import type { ExternalSourceConnectionStatus } from '../../external-sources/contracts';
import type { ExternalSourceController, ExternalSourceView } from './useExternalSourceController';
import { SourceExtensionManagerPanel } from '../extensions/SourceExtensionManagerPanel';

function statusLabel(connection: ExternalSourceConnectionStatus): string {
  switch (connection.state) {
    case 'connected':
      return '연결됨';
    case 'reauthorization_required':
      return '다시 연결 필요';
    case 'unavailable':
      return '사용할 수 없음';
    default:
      return '연결 안 됨';
  }
}

function initialFormValues(form: ExternalSourceConnectionForm | undefined): Record<string, string> {
  return Object.fromEntries(form?.fields.map((field) => [field.id, field.defaultValue ?? '']) ?? []);
}

function SourceCard({
  source,
  controller,
  favorite,
  toggleFavorite,
  onBrowse,
}: {
  source: ExternalSourceView;
  controller: ExternalSourceController;
  favorite: boolean;
  toggleFavorite: (id: string) => void;
  onBrowse?: (id: ExternalSourceView['id']) => void;
}) {
  const active = source.id === controller.activeSourceId;
  const connection = source.connection;
  const unavailable = connection.state === 'unavailable';
  const connected = connection.state === 'connected';
  const needsReauthorization = connection.state === 'reauthorization_required';
  const [values, setValues] = useState<Record<string, string>>(() => initialFormValues(source.connectionForm));
  const [manageExtensions, setManageExtensions] = useState(false);

  useEffect(() => {
    setValues(initialFormValues(source.connectionForm));
  }, [source.connectionForm, source.id]);

  const submitConnection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void controller.connect(values);
  };

  return (
    <article className={`external-source-settings-card${active ? ' active' : ''}`}>
      <button
        type="button"
        className="external-source-settings-card-heading"
        aria-pressed={active}
        onClick={() => void controller.selectSource(source.id)}
      >
        <span className="external-source-settings-icon" aria-hidden="true">
          {unavailable ? <CloudOff size={20} /> : <Cloud size={20} />}
        </span>
        <span>
          <strong>{source.title}</strong>
          <small>{source.description}</small>
        </span>
        <span className={`external-source-settings-status is-${connection.state}`}>
          {connected && <Check size={13} />}
          {statusLabel(connection)}
        </span>
      </button>

      <div className="installed-extension-actions">
        <button
          type="button"
          aria-pressed={favorite}
          aria-label={`${source.title} 즐겨찾기`}
          title={favorite ? '즐겨찾기 해제' : '즐겨찾기 필터에 추가'}
          onClick={() => toggleFavorite(source.id)}
        >
          <Star size={17} aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} />
          <span>즐겨찾기</span>
        </button>
        {connected && onBrowse && (
          <button type="button" onClick={() => onBrowse(source.id)}>
            작품 탐색
          </button>
        )}
      </div>
      {active && (
        <div className="external-source-settings-controls">
          {unavailable ? (
            <p className="field-help warning">
              {connection.reason ?? '현재 실행 환경에서는 이 소스를 사용할 수 없습니다.'}
            </p>
          ) : connected ? (
            <>
              <div className="external-source-settings-account">
                <span>현재 연결</span>
                <strong>{connection.label ?? source.title}</strong>
              </div>
              <button
                type="button"
                className="ghost-btn danger"
                disabled={controller.busy}
                onClick={() => void controller.disconnect()}
              >
                {controller.busy ? <LoaderCircle size={15} className="spin" /> : <Link2Off size={15} />}
                연결 해제
              </button>
              {source.extensionManager && (
                <>
                  <button
                    type="button"
                    aria-expanded={manageExtensions}
                    onClick={() => setManageExtensions(!manageExtensions)}
                  >
                    확장 저장소 관리
                  </button>
                  {manageExtensions && <SourceExtensionManagerPanel manager={source.extensionManager} />}
                </>
              )}
            </>
          ) : (
            <>
              {connection.reason && <p className="field-help">{connection.reason}</p>}
              {source.connectionForm ? (
                <form className="external-source-connection-form" onSubmit={submitConnection}>
                  {source.connectionForm.help && <p className="field-help">{source.connectionForm.help}</p>}
                  <div className="external-source-connection-fields">
                    {source.connectionForm.fields.map((field) => (
                      <label key={field.id}>
                        <span>{field.label}</span>
                        {field.type === 'select' ? (
                          <select
                            value={values[field.id] ?? ''}
                            required={field.required}
                            disabled={controller.busy}
                            onChange={(event) =>
                              setValues((current) => ({ ...current, [field.id]: event.target.value }))
                            }
                          >
                            {field.options?.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={field.type}
                            value={values[field.id] ?? ''}
                            required={field.required}
                            disabled={controller.busy}
                            placeholder={field.placeholder}
                            autoComplete={field.type === 'password' ? 'current-password' : 'off'}
                            onChange={(event) =>
                              setValues((current) => ({ ...current, [field.id]: event.target.value }))
                            }
                          />
                        )}
                        {field.help && <small>{field.help}</small>}
                      </label>
                    ))}
                  </div>
                  <button type="submit" className="primary-btn" disabled={controller.busy}>
                    {controller.busy ? <LoaderCircle size={15} className="spin" /> : <Link size={15} />}
                    {source.connectionForm.submitLabel ??
                      (needsReauthorization ? `${source.title} 다시 연결` : `${source.title} 연결`)}
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="primary-btn"
                  disabled={controller.busy}
                  onClick={() => void controller.connect()}
                >
                  {controller.busy ? <LoaderCircle size={15} className="spin" /> : <Link size={15} />}
                  {needsReauthorization ? `${source.title} 다시 연결` : `${source.title} 연결`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}

function SourceGroup({
  title,
  sources,
  controller,
  plugin,
  favorites,
  toggleFavorite,
  onBrowse,
}: {
  title: string;
  sources: readonly ExternalSourceView[];
  controller: ExternalSourceController;
  plugin?: boolean;
  favorites: readonly string[];
  toggleFavorite: (id: string) => void;
  onBrowse?: (id: ExternalSourceView['id']) => void;
}) {
  const Icon = plugin ? PlugZap : ShieldCheck;
  return (
    <section className="settings-section-card">
      <div className="settings-section-heading">
        <Icon size={18} aria-hidden="true" />
        <div>
          <h3>{title}</h3>
        </div>
      </div>
      {sources.length > 0 ? (
        <div className="external-source-settings-list">
          {sources.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              controller={controller}
              favorite={favorites.includes(source.id)}
              toggleFavorite={toggleFavorite}
              onBrowse={onBrowse}
            />
          ))}
        </div>
      ) : (
        <p className="muted external-source-settings-empty">
          {plugin ? '설치된 플러그인이 제공하는 외부 소스가 없습니다.' : '사용 가능한 기본 외부 소스가 없습니다.'}
        </p>
      )}
    </section>
  );
}

const FAVORITES_KEY = 'moya.source-favorites.v1';
function loadFavorites(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function ExternalSourceSettingsPanel({
  controller,
  onBrowse,
}: {
  controller: ExternalSourceController;
  onBrowse?: (id: ExternalSourceView['id']) => void;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [language, setLanguage] = useState('*');
  const [state, setState] = useState('all');
  const [favorites, setFavorites] = useState(loadFavorites);
  const [error, setError] = useState(false);
  const toggleFavorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter((value) => value !== id) : [...favorites, id];
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      setFavorites(next);
      setError(false);
    } catch {
      setError(true);
    }
  };
  const filtered = controller.sources.filter(
    (source) =>
      `${source.title} ${source.description ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
      (kind === 'all' || (source.contentKind ?? 'unknown') === kind) &&
      (language === '*' || (source.lang ?? 'unknown') === language) &&
      (state === 'all' || (state === 'favorite' ? favorites.includes(source.id) : source.connection.state === state)),
  );
  const languages = [
    ...new Set(controller.sources.map((source) => source.lang).filter((lang): lang is string => Boolean(lang))),
  ].sort();
  return (
    <div className="external-source-settings-sections">
      <div className="source-settings-filters">
        <label>
          소스 검색
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="이름 또는 설명"
          />
        </label>
        <label>
          콘텐츠
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="all">전체</option>
            <option value="text">소설·텍스트</option>
            <option value="image">만화·이미지</option>
            <option value="unknown">종류 정보 없음</option>
          </select>
        </label>
        <label>
          언어
          <select value={language} onChange={(event) => setLanguage(event.target.value)}>
            <option value="*">전체</option>
            {languages.map((lang) => (
              <option key={lang} value={lang}>
                {lang === 'all' ? '다국어' : lang}
              </option>
            ))}
            <option value="unknown">언어 정보 없음</option>
          </select>
        </label>
        <label>
          상태
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="all">전체</option>
            <option value="favorite">즐겨찾기</option>
            <option value="connected">연결됨</option>
            <option value="disconnected">연결 안 됨</option>
            <option value="reauthorization_required">다시 연결 필요</option>
            <option value="unavailable">사용할 수 없음</option>
          </select>
        </label>
      </div>
      <p role="status">
        {filtered.length} / {controller.sources.length}개 소스
      </p>
      {error && <p role="alert">즐겨찾기를 저장하지 못했습니다. 브라우저 저장공간을 확인해 주세요.</p>}
      {filtered.length === 0 && <p>조건에 맞는 소스가 없습니다. 검색어나 필터를 바꿔 주세요.</p>}
      <SourceGroup
        title="기본 외부 소스"
        sources={filtered.filter((source) => source.origin === 'built_in')}
        controller={controller}
        favorites={favorites}
        toggleFavorite={toggleFavorite}
        onBrowse={onBrowse}
      />
      <SourceGroup
        title="설치한 소스"
        sources={filtered.filter((source) => source.origin === 'plugin')}
        controller={controller}
        favorites={favorites}
        toggleFavorite={toggleFavorite}
        onBrowse={onBrowse}
        plugin
      />
    </div>
  );
}
