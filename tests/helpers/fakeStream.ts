/**
 * テスト用: client.beta.messages.stream を再現する
 */

import type Anthropic from '@anthropic-ai/sdk'

export type StreamBehavior =
  | {
      /** 本文の差分 */
      chunks: string[]
      thinking?: string
      stopReason?: string
      usage?: { input_tokens: number; output_tokens: number }
      /**
       * Web 検索（CHT-11）: 本文の前に検索ブロックを返す。citations は本文に付ける引用
       * filtered: 結果を絞り込む版の形（コード実行から検索を呼び、検索語は最初から入っている。本文に引用は無い）
       */
      search?: {
        query: string
        citations?: { url: string; title: string }[]
        results?: { url: string; title: string }[]
        requests?: number
        filtered?: boolean
      }
    }
  | { error: unknown }
  /** 差分を送った後、停止されるまで待つ */
  | { chunks: string[]; hang: true }

export interface FakeChat {
  client: Anthropic
  calls: Anthropic.Beta.MessageCreateParamsStreaming[]
}

export function fakeChatClient(behaviors: StreamBehavior[]): FakeChat {
  const calls: Anthropic.Beta.MessageCreateParamsStreaming[] = []
  let index = 0

  const stream = (
    params: Anthropic.Beta.MessageCreateParamsStreaming,
    options?: { signal?: AbortSignal }
  ): unknown => {
    // 呼び出し時点の内容を記録する（後で変更されないよう複製する）
    calls.push(JSON.parse(JSON.stringify(params)))
    const behavior = behaviors[Math.min(index++, behaviors.length - 1)]
    const signal = options?.signal
    let final: unknown = null

    async function* events(): AsyncGenerator<unknown> {
      if ('error' in behavior) throw behavior.error
      const usage =
        'usage' in behavior && behavior.usage
          ? behavior.usage
          : { input_tokens: 100, output_tokens: 20 }
      yield {
        type: 'message_start',
        message: { usage: { input_tokens: usage.input_tokens, output_tokens: 0 } }
      }
      const thinking = 'thinking' in behavior ? behavior.thinking : undefined
      if (thinking)
        yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking } }
      const search = 'search' in behavior ? behavior.search : undefined
      if (search?.filtered) {
        yield {
          type: 'content_block_start',
          content_block: { type: 'server_tool_use', name: 'code_execution', input: {} }
        }
        yield {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"code":"r=await web_search(...)"}' }
        }
        yield { type: 'content_block_stop' }
        yield {
          type: 'content_block_start',
          content_block: {
            type: 'server_tool_use',
            name: 'web_search',
            input: { query: search.query }
          }
        }
        yield { type: 'content_block_stop' }
      } else if (search) {
        yield {
          type: 'content_block_start',
          content_block: { type: 'server_tool_use', name: 'web_search', input: {} }
        }
        yield {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: search.query }) }
        }
        yield { type: 'content_block_stop' }
      }
      for (const text of behavior.chunks) {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text } }
      }
      if ('hang' in behavior) {
        await new Promise<void>((_, reject) => {
          const fail = (): void =>
            reject(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' }))
          if (signal?.aborted) fail()
          signal?.addEventListener('abort', fail)
        })
        return
      }
      yield { type: 'message_delta', usage: { output_tokens: usage.output_tokens } }
      const text = behavior.chunks.join('')
      final = {
        content: [
          ...(thinking ? [{ type: 'thinking', thinking, signature: 'sig-abc' }] : []),
          ...(search
            ? [
                {
                  type: 'server_tool_use',
                  id: 'srvtoolu_1',
                  name: 'web_search',
                  input: { query: search.query }
                },
                {
                  type: 'web_search_tool_result',
                  tool_use_id: 'srvtoolu_1',
                  content: (search.results ?? []).map((r) => ({ type: 'web_search_result', ...r }))
                }
              ]
            : []),
          {
            type: 'text',
            text,
            citations: search?.citations
              ? search.citations.map((c) => ({ type: 'web_search_result_location', ...c }))
              : null
          }
        ],
        stop_reason: behavior.stopReason ?? 'end_turn',
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          ...(search ? { server_tool_use: { web_search_requests: search.requests ?? 1 } } : {})
        }
      }
    }

    const iterator = events()
    return {
      [Symbol.asyncIterator]: () => iterator,
      // 実際の SDK と同じく、イベントを読まずに呼んでも最後まで受け取ってから返す
      finalMessage: async () => {
        for await (const _ of iterator) void _
        return final
      }
    }
  }

  return { client: { beta: { messages: { stream } } } as unknown as Anthropic, calls }
}
