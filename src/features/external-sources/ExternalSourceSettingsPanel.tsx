import { Check, Cloud, CloudOff, Link, Link2Off, LoaderCircle, PlugZap, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { ExternalSourceConnectionForm } from '../../external-sources/contracts';
import type { ExternalSourceConnectionStatus } from '../../external-sources/contracts';
import type { ExternalSourceController, ExternalSourceView } from './useExternalSourceController';

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

function SourceCard({ source, controller }: { source: ExternalSourceView; controller: ExternalSourceController }) {
  const active = source.id === controller.activeSourceId;
  const connection = source.connection;
  const unavailable = connection.state === 'unavailable';
  const connected = connection.state === 'connected';
  const needsReauthorization = connection.state === 'reauthorization_required';
  const [values, setValues] = useState<Record<string, string>>(() => initialFormValues(source.connectionForm));

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
  description,
  sources,
  controller,
  plugin,
}: {
  title: string;
  description: string;
  sources: readonly ExternalSourceView[];
  controller: ExternalSourceController;
  plugin?: boolean;
}) {
  const Icon = plugin ? PlugZap : ShieldCheck;
  return (
    <section className="settings-section-card">
      <div className="settings-section-heading">
        <Icon size={18} aria-hidden="true" />
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      {sources.length > 0 ? (
        <div className="external-source-settings-list">
          {sources.map((source) => (
            <SourceCard key={source.id} source={source} controller={controller} />
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

export function ExternalSourceSettingsPanel({ controller }: { controller: ExternalSourceController }) {
  const builtIns = controller.sources.filter((source) => source.origin === 'built_in');
  const plugins = controller.sources.filter((source) => source.origin === 'plugin');
  return (
    <div className="external-source-settings-sections">
      <SourceGroup
        title="기본 외부 소스"
        description="앱이 제공하는 저장소 연결입니다. 인증 정보는 이 기기의 자동 생성 키로 보호합니다."
        sources={builtIns}
        controller={controller}
      />
      <SourceGroup
        title="플러그인 제공 소스"
        description="향후 커뮤니티 플러그인이 제공하는 작품 사이트와 카탈로그를 여기에서 따로 관리합니다."
        sources={plugins}
        controller={controller}
        plugin
      />
    </div>
  );
}
