import { useContext } from 'react';
import { EmbeddedAccessContext } from '../../platform/embedded-access-context';
import { EmbeddedServerSharing } from '../../platform/EmbeddedServerSharing';
import { ServerAccessLink } from '../server-access/ServerAccessLink';

export function RemoteAccessSettings({ serverApiBaseUrl }: { readonly serverApiBaseUrl?: string }) {
  const embedded = useContext(EmbeddedAccessContext);
  if (embedded) return <EmbeddedServerSharing {...embedded} inline />;
  let address: URL | undefined;
  if (serverApiBaseUrl) {
    try {
      address = new URL(serverApiBaseUrl, window.location.href);
      address.pathname = address.pathname.replace(/\/api\/?$/, '/') || '/';
      address.search = '';
      address.hash = '';
      if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) address = undefined;
    } catch {
      /* No shareable address for a local-only library. */
    }
  }
  const loopback = address && /^(localhost|127(?:\.\d+){3}|\[::1\])$/i.test(address.hostname);
  return (
    <section className="settings-section-card">
      <h3>다른 기기에서 이 서재 열기</h3>
      {address ? (
        <>
          <p>같은 서버에 접속하면 이 서재를 그대로 이용할 수 있습니다.</p>
          {loopback ? (
            <p>
              현재 주소는 이 기기에서만 열 수 있습니다. 다른 기기에서는 서버의 LAN 주소나 공개 도메인으로 접속해 주세요.
            </p>
          ) : (
            <ServerAccessLink url={address.href} />
          )}
          <p className="reader-settings-scope-note">
            서버가 켜져 있어야 합니다. LAN 주소는 같은 네트워크에서 이용하고, 외부에서는 서버에 설정한 HTTPS 주소로
            접속하세요. 계정 암호는 QR에 포함되지 않습니다.
          </p>
        </>
      ) : (
        <p>
          이 브라우저에만 저장된 서재는 원격으로 열 수 없습니다. self-host 서버나 데스크톱 앱의 서재에서 원격 접속을
          설정하세요.
        </p>
      )}
    </section>
  );
}
