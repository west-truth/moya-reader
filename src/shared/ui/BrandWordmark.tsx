import { publicAssetUrl } from '../../utils/public-asset-url';

/** Preserve the wordmark shape while using the active theme's foreground. */
export function BrandWordmark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`app-wordmark ${className}`}
      role="img"
      aria-label="MOYA"
      style={{ maskImage: `url("${publicAssetUrl('/branding/moya-wordmark.png')}")` }}
    />
  );
}
