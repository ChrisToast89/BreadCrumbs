import { contextBridge, ipcRenderer } from 'electron';
import type { BreadCrumbsApi, IpcChannel, IpcRequest, IpcResponse } from '../shared/types.js';

/**
 * The renderer runs with `contextIsolation: true` and `nodeIntegration: false`,
 * so this bridge is its only route to the main process. Keep it a thin, typed
 * pass-through: no logic lives here.
 */
const api: BreadCrumbsApi = {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> {
    return ipcRenderer.invoke(channel, request) as Promise<IpcResponse<C>>;
  },
};

contextBridge.exposeInMainWorld('breadcrumbs', api);
