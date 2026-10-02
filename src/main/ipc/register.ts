/**
 * IPC ハンドラーの登録
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannel, IpcResult } from '@shared/ipc'
import { toIpcError } from './errors'
import type { IpcHandlers } from './handlers'

/**
 * 1 回の呼び出しを処理し、結果を IpcResult に包んで返す
 */
export async function invokeHandler(
  handlers: IpcHandlers,
  channel: IpcChannel,
  trusted: boolean,
  args: unknown[]
): Promise<IpcResult<unknown>> {
  if (!trusted) {
    console.warn(`[ipc] ${channel}: rejected untrusted sender`)
    return { ok: false, error: { code: 'forbidden', message: '許可されていない呼び出しです。' } }
  }
  try {
    return { ok: true, value: await handlers[channel](...args) }
  } catch (error) {
    return { ok: false, error: toIpcError(error, channel) }
  }
}

export function registerIpcHandlers(
  handlers: IpcHandlers,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
): void {
  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    ipcMain.handle(channel, (event, ...args: unknown[]) =>
      invokeHandler(handlers, channel, isTrustedSender(event), args)
    )
  }
}
