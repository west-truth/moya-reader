import { useState } from 'react';

export function RepositoryAddress({ url, checkedAt }: { url: string; checkedAt?: string | number }) {
  const [message, setMessage] = useState('');
  const safeLink = /^https?:\/\//i.test(url);
  return (
    <div className="repository-address">
      <p className="field-help installed-extension-origin">{url}</p>
      {checkedAt && <small>마지막 확인: {new Date(checkedAt).toLocaleString()}</small>}
      <div className="installed-extension-actions">
        {safeLink && (
          <a href={url} target="_blank" rel="noopener noreferrer">
            저장소 열기
          </a>
        )}
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setMessage('URL을 복사했습니다.');
            } catch {
              setMessage('복사하지 못했습니다. 표시된 주소를 직접 복사해 주세요.');
            }
          }}
        >
          URL 복사
        </button>
      </div>
      {message && <small role="status">{message}</small>}
    </div>
  );
}
