import { useEffect, useState } from 'react';
import type { AppInfo } from '../../shared/types.js';

/**
 * Phase 0 placeholder. The real three-pane layout (SPEC §7) arrives in phase 5,
 * built from the design tokens described in SPEC §12.
 */
export function App(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.breadcrumbs
      .invoke('app:info', undefined)
      .then(setInfo)
      .catch((cause: unknown) => setError(String(cause)));
  }, []);

  return (
    <main className="placeholder">
      <h1>BreadCrumbs</h1>
      <p>Splits a short video at its camera cuts and exports one still per shot.</p>
      {error ? (
        <p className="placeholder__error">IPC failed: {error}</p>
      ) : (
        <dl className="placeholder__info">
          <div>
            <dt>Version</dt>
            <dd>{info?.version ?? '…'}</dd>
          </div>
          <div>
            <dt>Electron</dt>
            <dd>{info?.electron ?? '…'}</dd>
          </div>
          <div>
            <dt>Chromium</dt>
            <dd>{info?.chrome ?? '…'}</dd>
          </div>
          <div>
            <dt>Platform</dt>
            <dd>{info?.platform ?? '…'}</dd>
          </div>
        </dl>
      )}
      <p className="placeholder__phase">Phase 0 — skeleton</p>
    </main>
  );
}
