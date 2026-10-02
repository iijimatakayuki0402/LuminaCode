/**
 * テスト用の Anthropic クライアント（models.list のみ）
 */

import Anthropic from '@anthropic-ai/sdk'

export interface FakeModel {
  id: string
  display_name?: string
  created_at: string
}

export function apiError(status: number, type: string): InstanceType<typeof Anthropic.APIError> {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type, message: 'error from api' } },
    'error from api',
    new Headers()
  )
}

export function fakeClient(behavior: { models?: FakeModel[]; error?: unknown }): {
  client: Anthropic
  calls: () => number
} {
  let count = 0
  const data = (behavior.models ?? []).map((m) => ({
    type: 'model',
    display_name: m.id,
    max_input_tokens: 1000000,
    max_tokens: 128000,
    ...m
  }))
  const list = (): unknown => {
    count++
    const page = behavior.error ? Promise.reject(behavior.error) : Promise.resolve({ data })
    page.catch(() => undefined)
    return Object.assign(page, {
      async *[Symbol.asyncIterator]() {
        if (behavior.error) throw behavior.error
        yield* data
      }
    })
  }
  return { client: { models: { list } } as unknown as Anthropic, calls: () => count }
}
