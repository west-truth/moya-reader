import { useEffect, useState } from 'react';
import {
  sourceReadingPreferences,
  sourceReadingPreferenceEvent,
} from '../../external-sources/source-reading-preferences';

/** Apply device setting changes without restarting an active streaming reader. */
export function useSourceReadingPreferences() {
  const [preferences, setPreferences] = useState(sourceReadingPreferences);
  useEffect(() => {
    const refresh = () => setPreferences(sourceReadingPreferences());
    window.addEventListener(sourceReadingPreferenceEvent, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(sourceReadingPreferenceEvent, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return preferences;
}
