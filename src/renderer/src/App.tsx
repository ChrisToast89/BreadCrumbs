import { useEffect } from 'react';
import { attachProgressListener, useStore } from './store.js';
import { Intake } from './components/Intake.js';
import { Workspace } from './components/Workspace.js';

/**
 * Two screens: intake until a clip is loaded, then the workspace (SPEC §7).
 * Errors keep the user on intake with a readable cause and a way to try
 * another file, rather than dropping them into an empty workspace.
 */
export function App(): JSX.Element {
  const screen = useStore((state) => state.screen);
  const analyze = useStore((state) => state.analyze);

  useEffect(() => attachProgressListener(), []);

  // Development only: load a clip named by BREADCRUMBS_OPEN so the interface
  // can be exercised without clicking through a native file dialog.
  useEffect(() => {
    void window.breadcrumbs.invoke('app:startupPath', undefined).then((path) => {
      if (path) void analyze(path);
    });
  }, [analyze]);

  return screen === 'workspace' ? <Workspace /> : <Intake />;
}
