/**
 * API エラーの分類と表示文言（要件 6.14）
 * 表示文言には API キーや送信内容を含めない。
 */

import Anthropic from '@anthropic-ai/sdk'
import type { ApiErrorKind } from '@shared/ipc'

export const API_ERROR_MESSAGES: Record<ApiErrorKind, string> = {
  auth: 'API キーが無効です。設定画面で API キーを確認してください。',
  permission:
    'この API キーには、この操作の権限がありません。設定画面で API キーを確認してください。',
  billing:
    'お支払いまたは残高に問題があります。Anthropic のコンソール（https://platform.claude.com）を確認してください。',
  rate_limit: '利用回数の上限に達しました。しばらく待ってから再度お試しください。',
  overloaded: 'Anthropic の API が混み合っています。しばらく待ってから再度お試しください。',
  server: 'Anthropic の API でエラーが発生しました。しばらく待ってから再度お試しください。',
  offline: 'オフラインです。インターネット接続を確認してください。',
  timeout: '応答がありませんでした（タイムアウト）。接続を確認して再度お試しください。',
  too_large: '入力が大きすぎます。会話の圧縮や、添付ファイルの削減を行ってください。',
  bad_request: 'リクエストが受け付けられませんでした。',
  not_found: '指定したモデルなどが見つかりません。モデル一覧を更新してください。',
  unknown: 'API の呼び出しで予期しないエラーが発生しました。'
}

/** API 呼び出しの失敗（message は画面にそのまま表示できる） */
export class ApiRequestError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    public readonly status: number | undefined
  ) {
    super(API_ERROR_MESSAGES[kind])
    this.name = 'ApiRequestError'
  }
}

function kindOf(error: unknown): { kind: ApiErrorKind; status?: number } {
  // APIConnectionError は APIError のサブクラスのため先に判定する
  if (error instanceof Anthropic.APIConnectionTimeoutError) return { kind: 'timeout' }
  if (error instanceof Anthropic.APIConnectionError) return { kind: 'offline' }
  if (error instanceof Anthropic.AuthenticationError) return { kind: 'auth', status: 401 }
  if (error instanceof Anthropic.PermissionDeniedError) return { kind: 'permission', status: 403 }
  if (error instanceof Anthropic.NotFoundError) return { kind: 'not_found', status: 404 }
  if (error instanceof Anthropic.RateLimitError) return { kind: 'rate_limit', status: 429 }
  if (error instanceof Anthropic.APIError) {
    const status = error.status
    if (status === 402 || error.type === 'billing_error') return { kind: 'billing', status }
    if (status === 413) return { kind: 'too_large', status }
    if (status === 529 || error.type === 'overloaded_error') return { kind: 'overloaded', status }
    if (status !== undefined && status >= 500) return { kind: 'server', status }
    if (status === 400) return { kind: 'bad_request', status }
    return { kind: 'unknown', status }
  }
  return { kind: 'unknown' }
}

/**
 * SDK の例外を ApiRequestError に変換する
 * ログには種別とステータスのみを出す（本文・キーは出さない。要件 SEC-31、6.14）
 */
export function toApiRequestError(error: unknown, operation: string): ApiRequestError {
  if (error instanceof ApiRequestError) return error
  const { kind, status } = kindOf(error)
  console.warn(`[api] ${operation} failed: kind=${kind} status=${status ?? '-'}`)
  return new ApiRequestError(kind, status)
}
