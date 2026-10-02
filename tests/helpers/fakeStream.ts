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
          { type: 'text', text, citations: null }
        ],
        stop_reason: behavior.stopReason ?? 'end_turn',
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      }
    }

    const iterator = events()
    return {
      [Symbol.asyncIterator]: () => iterator,
      finalMessage: async () => final
    }
  }

  return { client: { beta: { messages: { stream } } } as unknown as Anthropic, calls }
}
