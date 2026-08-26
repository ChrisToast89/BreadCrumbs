import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type {
  AnalyzedProject,
  AppInfo,
  IpcChannel,
  IpcContract,
  ExportOutcome,
  IpcResult,
  PipelineProgressEvent,
  Platform,
  VideoIndex,
} from '../shared/types.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';
import { MediaError, indexVideo } from './media/indexVideo.js';
import { projectDirFor } from './media/proxy.js';
import { runPipeline } from './pipeline.js';
import { exportFrames } from './media/exportFrames.js';

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

/**
 * Serve the proxy with byte-range support.
 *
 * This has to be a real range server, not a whole-file response. Chromium only
 * treats a media resource as seekable when the server advertises ranges, and an
 * unseekable <video> silently clamps every `currentTime` assignment back to
 * zero — while still firing `seeked`, so it looks like a fast successful seek
 * and the preview simply never leaves the first frame. Seeking is the entire
 * job of the preview (SPEC §2), so this is load-bearing.
 */
function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const target = decodeURIComponent(url.pathname.replace(/^\//, ''));

    // Never serve an arbitrary path just because the renderer asked for it.
    if (!servableMedia.has(target)) {
      return new Response('Not found', { status: 404 });
    }

    let size: number;
    try {
      size = (await stat(target)).size;
    } catch {
      return new Response('Not found', { status: 404 });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      // The proxy is regenerated per source and served only to this window.
      'Cache-Control': 'no-store',
    };

    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '');
    if (!range) {
      return new Response(Readable.toWeb(createReadStream(target)) as ReadableStream, {
        status: 200,
        headers: { ...headers, 'Content-Length': String(size) },
      });
    }

    // A range request. An open-ended start ("bytes=-500") counts back from the
    // end; an open-ended end runs to the last byte.
    const [, startText, endText] = range;
    let start: number;
    let end: number;

    if (startText === '') {
      const suffix = Number(endText);
      start = Math.max(0, size - (Number.isFinite(suffix) ? suffix : 0));
      end = size - 1;
    } else {
      start = Number(startText);
      end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${size}` },
      });
    }

    return new Response(Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      },
    });
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

  handle('export:chooseFolder', async ({ current }): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder to export into',
      buttonLabel: 'Export here',
      properties: ['openDirectory', 'createDirectory'],
      ...(current ? { defaultPath: current } : {}),
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle('export:reveal', ({ path }): void => {
    shell.showItemInFolder(path);
  });

  handle('export:run', async (request): Promise<IpcResult<ExportOutcome>> => {
    const window = BrowserWindow.getAllWindows()[0];
    try {
      const index = await indexVideo(request.sourcePath);

      const result = await exportFrames({
        index,
        entries: request.entries,
        outputDir: request.outputDir,
        format: request.format,
        quality: request.quality,
        overwrite: request.overwrite,
        onProgress: (written, total) => window?.webContents.send('export:progress', { written, total }),
      });

      return {
        ok: true,
        value: {
          written: result.written,
          manifestPath: result.manifestPath,
          outputDir: request.outputDir,
          elapsedMs: result.elapsedMs,
          collisions: result.collisions,
        },
      };
    } catch (cause) {
      const problem =
        cause instanceof MediaError ? cause.message : `${basename(request.sourcePath)}: ${String(cause)}`;
      return { ok: false, problem };
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
          metrics: result.metrics,
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
