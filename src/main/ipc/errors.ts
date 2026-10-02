/**
 * IPC で返すエラーの定義と変換
 */

import type { IpcError } from '@shared/ipc'
import { ApiRequestError } from '../api/errors'
import { ValidationError } from '../db/operations'

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

/** renderer から渡された引数の型・形式が不正 */
export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidArgumentError'
  }
}

/**
 * 例外を IPC のエラー値に変換する
 * 想定外の例外は詳細を renderer に渡さず、main のログにのみ出す（要件 10.2）
 */
export function toIpcError(error: unknown, channel: string): IpcError {
  if (error instanceof ValidationError) return { code: 'validation', message: error.message }
  if (error instanceof NotFoundError) return { code: 'not_found', message: error.message }
  if (error instanceof ApiRequestError) {
    return { code: 'api', message: error.message, apiKind: error.kind }
  }
  if (error instanceof InvalidArgumentError) {
    return { code: 'invalid_argument', message: error.message }
  }

  console.error(`[ipc] ${channel} failed:`, error)
  return { code: 'internal', message: '予期しないエラーが発生しました。' }
}
