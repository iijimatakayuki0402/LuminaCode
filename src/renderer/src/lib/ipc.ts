import type { IpcErrorCode, IpcResult } from '@shared/ipc'

/**
 * IPC のエラー。message は画面に表示できる文言
 */
export class AppError extends Error {
  constructor(
    public readonly code: IpcErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/**
 * IpcResult を値に戻す。失敗時は AppError を投げる
 */
export async function unwrap<T>(result: Promise<IpcResult<T>>): Promise<T> {
  const r = await result
  if (!r.ok) throw new AppError(r.error.code, r.error.message)
  return r.value
}
