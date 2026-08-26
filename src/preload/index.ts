import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type {
  BreadCrumbsApi,
  IpcChannel,
  IpcEventName,
  IpcEvents,
  IpcRequest,
  IpcResponse,
} from '../shared/types.js';

/**
 * The renderer runs with `contextIsolation: true` and `nodeIntegration: false`,
 * so this bridge is its only route to the main process. Keep it a thin, typed
 * pass-through: no logic lives here.
 */
const api: BreadCrumbsApi = {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> {
    return ipcRenderer.invoke(channel, request) as Promise<IpcResponse<C>>;
  },

  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, payload: IpcEvents[E]): void => listener(payload);
    ipcRenderer.on(event, wrapped);
    return () => {
      ipcRenderer.off(event, wrapped);
    };
  },

  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('breadcrumbs', api);
