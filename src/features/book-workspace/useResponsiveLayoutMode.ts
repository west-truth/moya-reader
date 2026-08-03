import { useEffect, useState } from 'react';

export type ResponsiveLayoutMode = 'wide' | 'compact' | 'mobile';

const MOBILE_QUERY = '(max-width: 699px)';
const COMPACT_QUERY = '(max-width: 1279px)';

function readLayoutMode(): ResponsiveLayoutMode {
  if (typeof window === 'undefined') return 'wide';
  if (window.matchMedia(MOBILE_QUERY).matches) return 'mobile';
  if (window.matchMedia(COMPACT_QUERY).matches) return 'compact';
  return 'wide';
}

export function useResponsiveLayoutMode(): ResponsiveLayoutMode {
  const [mode, setMode] = useState<ResponsiveLayoutMode>(readLayoutMode);

  useEffect(() => {
    const mobile = window.matchMedia(MOBILE_QUERY);
    const compact = window.matchMedia(COMPACT_QUERY);
    const update = () => setMode(readLayoutMode());
    mobile.addEventListener('change', update);
    compact.addEventListener('change', update);
    update();
    return () => {
      mobile.removeEventListener('change', update);
      compact.removeEventListener('change', update);
    };
  }, []);

  return mode;
}
