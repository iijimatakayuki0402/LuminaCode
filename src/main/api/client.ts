/**
 * Anthropic API クライアントの生成
 * 実行環境の環境変数（ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 等）は使わず、
 * アプリに保存した API キーと公式の接続先だけを使う（Phase 0 で、環境の認証情報が混入する問題を確認済み）。
 */

import Anthropic from '@anthropic-ai/sdk'

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

/** 要件 6.14: 429・529・5xx は最大 3 回まで自動リトライ（SDK が指数バックオフで行う） */
export const MAX_RETRIES = 3

export function createAnthropicClient(
  apiKey: string,
  options: { maxRetries?: number } = {}
): Anthropic {
  return new Anthropic({
    apiKey,
    authToken: null,
    baseURL: ANTHROPIC_BASE_URL,
    maxRetries: options.maxRetries ?? MAX_RETRIES
  })
}

export type ClientFactory = (apiKey: string, options?: { maxRetries?: number }) => Anthropic
