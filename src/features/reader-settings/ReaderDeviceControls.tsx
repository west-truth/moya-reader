import { Lock, MonitorUp, Unlock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
}

interface OrientationLike {
  lock?: (orientation: 'portrait' | 'landscape') => Promise<void>;
  unlock?: () => void;
}

export function ReaderDeviceControls() {
  const sentinelRef = useRef<WakeLockSentinelLike>();
  const [wakeLocked, setWakeLocked] = useState(false);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>();
  const wakeLockAvailable = Boolean((navigator as Navigator & { wakeLock?: unknown }).wakeLock);
  const orientationApi = screen.orientation as ScreenOrientation & OrientationLike;
  const orientationAvailable = typeof orientationApi.lock === 'function';

  useEffect(
    () => () => {
      void sentinelRef.current?.release();
      orientationApi.unlock?.();
    },
    [orientationApi],
  );

  if (!wakeLockAvailable && !orientationAvailable) return null;

  const toggleWakeLock = async () => {
    if (sentinelRef.current && !sentinelRef.current.released) {
      await sentinelRef.current.release();
      sentinelRef.current = undefined;
      setWakeLocked(false);
      return;
    }
    const wakeLock = (navigator as Navigator & { wakeLock: { request(type: 'screen'): Promise<WakeLockSentinelLike> } })
      .wakeLock;
    sentinelRef.current = await wakeLock.request('screen');
    setWakeLocked(true);
  };

  const setOrientationLock = async (next?: 'portrait' | 'landscape') => {
    if (!next) {
      orientationApi.unlock?.();
      setOrientation(undefined);
      return;
    }
    await orientationApi.lock?.(next);
    setOrientation(next);
  };

  return (
    <section>
      <h3>기기</h3>
      <div className="reader-device-controls">
        {wakeLockAvailable && (
          <button
            type="button"
            className={`ghost-btn${wakeLocked ? ' active' : ''}`}
            onClick={() => void toggleWakeLock()}
          >
            {wakeLocked ? <Lock size={16} /> : <Unlock size={16} />} 화면 켜짐
          </button>
        )}
        {orientationAvailable && (
          <label>
            <MonitorUp size={16} />
            <select
              value={orientation ?? ''}
              onChange={(event) =>
                void setOrientationLock((event.target.value || undefined) as 'portrait' | 'landscape' | undefined)
              }
            >
              <option value="">회전 자동</option>
              <option value="portrait">세로 고정</option>
              <option value="landscape">가로 고정</option>
            </select>
          </label>
        )}
      </div>
    </section>
  );
}
