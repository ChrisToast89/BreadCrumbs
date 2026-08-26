import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type {
  AnalyzedProject,
  AppInfo,
  IpcChannel,
  IpcContract,
  IpcResult,
  PipelineProgressEvent,
  Platform,
  VideoIndex,
} from '../shared/types.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';
import { MediaError, indexVideo } from './media/indexVideo.js';
import { projectDirFor } from './media/proxy.js';
import { runPipeline } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The preview plays the proxy in a <video> element, and a renderer served over
 * http in development cannot read file:// URLs. A privileged scheme keeps the
 * proxy streaming (range requests included) without loosening the CSP to
 * file: or copying 20MB into a blob.
 */
const MEDIA_SCHEME = 'bc-media';

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
]);

/** Only paths handed out by this process are servable. */
const servableMedia = new Set<string>();

function mediaUrlFor(absolutePath: string): string {
  servableMedia.add(absolutePath);
  return `${MEDIA_SCHEME}://media/${encodeURIComponent(absolutePath)}`;
}

function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const url = new URL(request.url);
    const target = decodeURIComponent(url.pathname.replace(/^\//, ''));

    // Never serve an arbitrary path just because the renderer asked for it.
    if (!servableMedia.has(target)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString(), { bypassCustomProtocolHandlers: true });
  });
}

/**
 * Register one IPC handler, typed against the contract in shared/types.ts.
 * Using this instead of a bare `ipcMain.handle` keeps channel names and payload
 * shapes from drifting apart between the two processes.
 */
function handle<C extends IpcChannel>(
  channel: C,
  handler: (
    request: IpcContract[C]['request'],
  ) => Promise<IpcContract[C]['response']> | IpcContract[C]['response'],
): void {
  ipcMain.handle(channel, (_event, request) => handler(request));
}

function registerHandlers(): void {
  handle('video:index', async ({ path }): Promise<IpcResult<VideoIndex>> => {
    try {
      return { ok: true, value: await indexVideo(path) };
    } catch (cause) {
      // SPEC §9 — name the file and the problem, never surface a stack trace.
      const problem = cause instanceof MediaError ? cause.message : `${basename(path)}: ${String(cause)}`;
      return { ok: false, problem };
    }
  });

  handle('app:startupPath', (): string | null => {
    // Development only — see the channel's note in shared/types.ts.
    const requested = process.env['BREADCRUMBS_OPEN'];
    if (!requested) return null;
    const resolved = resolve(requested);
    return existsSync(resolved) ? resolved : null;
  });

  handle('project:choose', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a video',
      buttonLabel: 'Choose',
      properties: ['openFile'],
      filters: [
        // Containers named in SPEC §1.
        { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle('project:analyze', async ({ path }): Promise<IpcResult<AnalyzedProject>> => {
    // Two runs against one clip share a project folder and would write the same
    // proxy at the same time, leaving a file whose container header is valid
    // but whose picture data is shredded. Joining the in-flight run is both
    // safer and what the caller wanted anyway.
    const existing = analysesInFlight.get(path);
    if (existing) return existing;

    const run = analyzeProject(path);
    analysesInFlight.set(path, run);
    try {
      return await run;
    } finally {
      analysesInFlight.delete(path);
    }
  });

  handle('app:info', (): AppInfo => ({
    name: 'BreadCrumbs',
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    // SPEC §1 targets Windows, macOS and Linux; no other platform is supported.
    platform: process.platform as Platform,
  }));
}

/** Analyses currently running, keyed by source path. */
const analysesInFlight = new Map<string, Promise<IpcResult<AnalyzedProject>>>();

async function analyzeProject(path: string): Promise<IpcResult<AnalyzedProject>> {
  const window = BrowserWindow.getAllWindows()[0];

  {
    try {
      const projectDir = await projectDirFor(join(app.getPath('userData'), 'projects'), path);

      const result = await runPipeline({
        sourcePath: path,
        projectDir,
        onProgress: (progress) => {
          const payload: PipelineProgressEvent = {
            overall: progress.overall,
            step: progress.step,
            stepFraction: progress.stepFraction,
            states: progress.states,
          };
          window?.webContents.send('pipeline:progress', payload);
        },
      });

      // Concatenate the thumbnails into one buffer with an offset table: a
      // single structured-clone transfer rather than thousands of small ones.
      const { thumbnails } = result.analysis;
      const offsets: number[] = [0];
      let total = 0;
      for (const thumbnail of thumbnails) {
        total += thumbnail.length;
        offsets.push(total);
      }
      const packed = Buffer.allocUnsafe(total);
      let cursor = 0;
      for (const thumbnail of thumbnails) {
        thumbnail.copy(packed, cursor);
        cursor += thumbnail.length;
      }

      return {
        ok: true,
        value: {
          sourcePath: path,
          sourceName: basename(path),
          projectDir,
          proxyUrl: mediaUrlFor(result.proxy.path),
          proxyWidth: result.proxy.width,
          proxyHeight: result.proxy.height,
          index: result.index,
          shots: result.shots,
          picks: result.picks,
          settings: DEFAULT_SETTINGS,
          thumbnails: {
            data: packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength),
            offsets,
            width: result.analysis.thumbnailWidth,
            height: result.analysis.thumbnailHeight,
          },
          elapsedMs: result.elapsedMs,
        },
      };
    } catch (cause) {
      const problem = cause instanceof MediaError ? cause.message : `${basename(path)}: ${String(cause)}`;
      return { ok: false, problem };
    }
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    // SPEC §7 lays out three panes across a minimum useful width; the phase 5
    // gate requires a clean resize down to 1100px, so that is the floor.
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#191c20',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Nothing in this application should navigate away or spawn a browser window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

void app.whenReady().then(() => {
  registerMediaProtocol();
  registerHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
