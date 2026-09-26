import { useEffect, useState } from 'react';
import type {
  InstalledExtensionManager,
  PortableVaultStatus,
} from '../../extensions/packages/installed-extension-manager';

export function PortableSourceVault({ manager }: { manager: InstalledExtensionManager }) {
  const [status, setStatus] = useState<PortableVaultStatus>();
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void manager
      .portableVaultStatus?.()
      .then((value) => {
        if (live) setStatus(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [manager]);
  if (!status?.supported || !manager.portableVaultUnlock || !manager.portableVaultLock) return null;
  const submit = async () => {
    if (!status.configured && passphrase !== confirmation) {
      setError('암호가 일치하지 않습니다.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      setStatus(await manager.portableVaultUnlock!(passphrase));
      setPassphrase('');
      setConfirmation('');
    } catch (cause) {
      setError(
        typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '보관소를 열지 못했습니다.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section-card" aria-label="소스 보관소">
      <div className="settings-section-heading">
        <div>
          <h3>소스 보관소</h3>
          <p>
            {status.unlocked
              ? '이 실행에서 잠금 해제됨'
              : status.configured
                ? '암호를 입력해 잠금 해제하세요.'
                : '소스 설정과 로그인을 저장할 암호를 만드세요.'}
          </p>
        </div>
      </div>
      {status.unlocked ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void manager.portableVaultLock!()
              .then(setStatus)
              .catch((cause) => setError(typeof cause === 'string' ? cause : '잠그지 못했습니다.'))
              .finally(() => setBusy(false));
          }}
        >
          잠그기
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            암호{' '}
            <input
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              minLength={12}
              maxLength={1024}
              required
            />
          </label>
          {!status.configured && (
            <label>
              암호 확인{' '}
              <input
                type="password"
                autoComplete="off"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                minLength={12}
                maxLength={1024}
                required
              />
            </label>
          )}
          <button type="submit" disabled={busy}>
            {status.configured ? '잠금 해제' : '보관소 만들기'}
          </button>
        </form>
      )}
      {error && (
        <p className="field-help warning" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
