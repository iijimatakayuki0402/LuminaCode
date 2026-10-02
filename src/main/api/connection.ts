/**
 * API キーの疎通テスト（要件 KEY-02）
 * Models API を 1 件だけ取得する。トークンを消費しないため課金されない。
 */

import type { ClientFactory } from './client'
import { toApiRequestError } from './errors'

export async function testApiKey(createClient: ClientFactory, apiKey: string): Promise<void> {
  // 入力直後の確認なので、リトライで待たせすぎないようにする
  const client = createClient(apiKey, { maxRetries: 1 })
  try {
    await client.models.list({ limit: 1 })
  } catch (error) {
    throw toApiRequestError(error, 'apiKey.test')
  }
}
