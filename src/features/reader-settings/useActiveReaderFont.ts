import { useEffect, useState } from 'react';
import type { UserFontAsset } from '../../domain/types';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import { builtinFontFamily, loadUserFont } from './user-font-runtime';

export function useActiveReaderFont(
  repository: ReaderPersonalizationRepository | undefined,
  fontId: string,
): { family: string; failed: boolean } {
  const builtin = builtinFontFamily(fontId);
  const [state, setState] = useState({ family: builtin ?? 'var(--font-serif)', failed: false });

  useEffect(() => {
    const nextBuiltin = builtinFontFamily(fontId);
    if (nextBuiltin) {
      setState({ family: nextBuiltin, failed: false });
      return;
    }
    let cancelled = false;
    void repository
      ?.listUserFonts()
      .then((fonts) =>
        loadUserFont(
          repository,
          fonts.find((font: UserFontAsset) => font.id === fontId),
        ),
      )
      .then((family) => {
        if (!cancelled) setState({ family: family ?? 'var(--font-serif)', failed: !family });
      })
      .catch(() => {
        if (!cancelled) setState({ family: 'var(--font-serif)', failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [fontId, repository]);

  return state;
}
