import { useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Copy } from 'lucide-react';
import './server-access.css';

/** Shared by the desktop host and authenticated self-host web settings. No credentials in the QR. */
export function ServerAccessLink({ url }: { readonly url: string }) {
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const qr = useMemo(() => {
    const value = new URL(url);
    if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.search || value.hash)
      return undefined;
    const address = value.href;
    if (address.length > 2048) return undefined;
    const code = qrcode(0, 'M');
    code.addData(address);
    code.make();
    const size = code.getModuleCount();
    const pixels = [];
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (code.isDark(y, x)) pixels.push(`M${x + 4},${y + 4}h1v1h-1z`);
      }
    return { size: size + 8, path: pixels.join('') };
  }, [url]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setMessage('주소를 복사했습니다.');
    } catch {
      input.current?.focus();
      input.current?.select();
      setMessage('선택된 주소를 복사해 주세요.');
    }
  };
  return (
    <div className="server-access-link">
      {qr && (
        <svg
          role="img"
          aria-label="서재 접속 QR 코드"
          className="server-access-qr"
          viewBox={`0 0 ${qr.size} ${qr.size}`}
          shapeRendering="crispEdges"
        >
          <rect width={qr.size} height={qr.size} fill="#fff" />
          <path d={qr.path} fill="#000" />
        </svg>
      )}
      <p>다른 기기에서 QR 코드를 스캔한 뒤 모야 계정으로 로그인하세요.</p>
      <div className="server-access-address">
        <input
          ref={input}
          aria-label="다른 기기 접속 주소"
          readOnly
          value={url}
          onFocus={(event) => event.target.select()}
        />
        <button type="button" className="ghost-btn" aria-label="접속 주소 복사" onClick={() => void copy()}>
          <Copy size={20} />
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
