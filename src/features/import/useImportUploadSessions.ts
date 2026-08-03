import { useCallback, useRef, useState } from 'react';
import type { ImportService } from '../../services/import/import-service';
import type { StoredUploadSessionEntry } from '../../services/import/server-upload-import-service';
import type { ToastTone } from '../../shared/ui/ToastHost';

interface ImportServiceWithUploadSessions extends ImportService {
  listStoredUploadSessions(): StoredUploadSessionEntry[];
  forgetStoredUploadSession(key: string): Promise<void> | void;
}

export interface ImportUploadSessionLifecycle {
  sessions: readonly StoredUploadSessionEntry[];
  refresh(): void;
  forget(key: string): Promise<void>;
}

function supportsUploadSessions(service: ImportService): service is ImportServiceWithUploadSessions {
  const candidate = service as Partial<ImportServiceWithUploadSessions>;
  return (
    typeof candidate.listStoredUploadSessions === 'function' &&
    typeof candidate.forgetStoredUploadSession === 'function'
  );
}

export function useImportUploadSessions(
  service: ImportService,
  notify: (message: string, tone?: ToastTone) => void,
): ImportUploadSessionLifecycle {
  const dependenciesRef = useRef({ service, notify });
  dependenciesRef.current = { service, notify };
  const [sessions, setSessions] = useState<StoredUploadSessionEntry[]>([]);

  const refresh = useCallback(() => {
    const currentService = dependenciesRef.current.service;
    setSessions(supportsUploadSessions(currentService) ? currentService.listStoredUploadSessions() : []);
  }, []);

  const forget = useCallback(async (key: string) => {
    const { service: currentService, notify: currentNotify } = dependenciesRef.current;
    if (!supportsUploadSessions(currentService)) return;
    try {
      await currentService.forgetStoredUploadSession(key);
      setSessions(currentService.listStoredUploadSessions());
      currentNotify('서버 업로드 기록을 지웠습니다.', 'info');
    } catch {
      currentNotify('서버 업로드 기록을 지우지 못했습니다.', 'danger');
    }
  }, []);

  return { sessions, refresh, forget };
}
