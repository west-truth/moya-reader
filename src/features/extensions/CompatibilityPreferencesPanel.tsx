import { useEffect, useState } from 'react';
import type { ApkExtensionManager } from '../../extensions/packages/apk-extension-manager';
import type { CompatibilityPreferences } from '../../extensions/packages/compatibility-preferences';

export function CompatibilityPreferencesPanel({
  manager,
  pkg,
  onSaved,
}: {
  manager: Pick<ApkExtensionManager, 'preferences' | 'savePreferences'>;
  pkg: string;
  onSaved(): void;
}) {
  const [snapshot, setSnapshot] = useState<CompatibilityPreferences>();
  const [changes, setChanges] = useState<Record<string, string | number | boolean | null>>({});
  const [origins, setOrigins] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [group, setGroup] = useState('');
  useEffect(() => {
    let active = true;
    void manager.preferences!(pkg)
      .then((value) => {
        if (active) {
          setSnapshot(value);
          setGroup(value.groups?.[0]?.id ?? '');
          setOrigins(value.privateOrigins.join('\n'));
        }
      })
      .catch(() => {
        if (active) setMessage('설정을 읽지 못했습니다. 다시 열어 주세요.');
      });
    return () => {
      active = false;
    };
  }, [manager, pkg]);
  return (
    <form
      className="compatibility-preferences"
      aria-label="확장 옵션"
      onSubmit={(event) => {
        event.preventDefault();
        if (!snapshot) return;
        setBusy(true);
        setMessage('');
        const enteredServiceOrigins = snapshot.fields.flatMap((field) => {
          const value = changes[field.key];
          if (snapshot.networkPolicy === 'direct' || field.secret || field.kind !== 'text' || typeof value !== 'string')
            return [];
          try {
            const url = new URL(value);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? [url.origin] : [];
          } catch {
            return [];
          }
        });
        void manager.savePreferences!(pkg, snapshot.revision, changes, [
          ...new Set([
            ...origins
              .split(/\r?\n/)
              .map((v) => v.trim())
              .filter(Boolean),
            ...enteredServiceOrigins,
          ]),
        ])
          .then(async () => {
            setChanges({});
            setSnapshot(await manager.preferences!(pkg));
            setMessage('저장했습니다.');
            onSaved();
          })
          .catch(() => setMessage('저장하지 못했습니다. 입력한 값과 주소를 확인하고 설정을 다시 열어 주세요.'))
          .finally(() => setBusy(false));
      }}
    >
      {!snapshot && !message && (
        <p role="status" className="field-help">
          설정을 불러오는 중…
        </p>
      )}
      {snapshot?.groups && snapshot.groups.length > 1 && (
        <label className="compatibility-preference-field">
          <span>소스 선택</span>
          <select
            aria-label="소스 선택"
            value={group}
            disabled={busy}
            onChange={(event) => setGroup(event.target.value)}
          >
            {snapshot.groups.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {snapshot?.groups?.find((item) => item.id === group)?.unavailable && (
        <p role="status">이 소스의 설정에는 아직 지원하지 않는 기능이 있습니다.</p>
      )}
      {snapshot?.fields
        .filter((field) => !field.group || field.group === group)
        .map((field) => {
          const value = Object.prototype.hasOwnProperty.call(changes, field.key) ? changes[field.key] : field.value;
          return (
            <label
              key={field.key}
              className={`compatibility-preference-field${field.kind === 'boolean' ? ' compatibility-preference-toggle' : ''}`}
            >
              <span>{field.title}</span>
              {field.kind === 'boolean' ? (
                <input
                  type="checkbox"
                  disabled={busy || field.disabled}
                  checked={value === true}
                  onChange={(e) => setChanges({ ...changes, [field.key]: e.target.checked })}
                />
              ) : field.kind === 'select' ? (
                <select
                  disabled={busy || field.disabled}
                  value={String(value ?? '')}
                  onChange={(e) => {
                    const choice = field.choices?.find((c) => String(c.value) === e.target.value);
                    if (choice) setChanges({ ...changes, [field.key]: choice.value });
                  }}
                >
                  {field.choices?.map((c) => (
                    <option key={String(c.value)} value={String(c.value)}>
                      {c.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.secret ? 'password' : 'text'}
                  disabled={busy || field.disabled}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={String(value ?? '')}
                  placeholder={field.secret && field.configured ? '저장됨 · 변경할 때만 입력' : ''}
                  onChange={(e) => setChanges({ ...changes, [field.key]: e.target.value })}
                />
              )}
              {field.summary && <small className="field-help">{field.summary}</small>}
            </label>
          );
        })}
      {snapshot && snapshot.networkPolicy !== 'direct' && (
        <details>
          <summary>로컬 서버 접근 허용</summary>
          <p className="field-help">
            확장이 사용하는 인증 서버가 로컬·사설 주소라면 허용할 주소를 한 줄에 하나씩 입력하세요. 경로 없이
            프로토콜·호스트·포트만 입력합니다. 서버에서 실행할 때 localhost는 서버 자신을 가리킵니다.
          </p>
          <textarea
            aria-label="허용할 로컬 서버 주소"
            placeholder="http://192.168.1.10:8080"
            value={origins}
            disabled={busy}
            onChange={(e) => setOrigins(e.target.value)}
          />
        </details>
      )}
      {snapshot?.groups?.find((item) => item.id === group)?.unsupportedActions ? (
        <p className="field-help">확장 자체의 버튼·별도 창을 여는 동작은 이 화면에서 지원하지 않습니다.</p>
      ) : null}
      {snapshot &&
        !snapshot.fields.some((field) => !field.group || field.group === group) &&
        !snapshot.groups?.find((item) => item.id === group)?.unavailable && (
          <p className="field-help">이 소스에는 변경할 수 있는 옵션이 없습니다.</p>
        )}
      <details className="extension-settings-note">
        <summary>설정 저장 및 연결 안내</summary>
        <p className="field-help">
          옵션과 인증 정보는 실행하는 서버 또는 기기에 암호화해 보관합니다. 저장 후 작품의 회차를 열어 연결 상태를
          확인할 수 있습니다.
        </p>
      </details>
      {message && (
        <p role="status" className="field-help">
          {message}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !snapshot || (!Object.keys(changes).length && origins === snapshot.privateOrigins.join('\n'))}
      >
        {busy ? '저장 중…' : '설정 저장'}
      </button>
    </form>
  );
}
