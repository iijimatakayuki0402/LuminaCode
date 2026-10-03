import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { echoBlocks, fallbackOf, splitUsage } from '../../src/main/chat/fallback'

const fallbackBlock = (from: string, to: string): { type: string; from: object; to: object } => ({
  type: 'fallback',
  from: { model: from },
  to: { model: to }
})

describe('拒否されたときのフォールバック（CHT-16）', () => {
  it('送り返すときは、最後の切り替えより前の思考・ツール呼び出しと fallback ブロックを除く', () => {
    const blocks = [
      { type: 'thinking', thinking: '前のモデルの思考' },
      { type: 'text', text: '途中まで' },
      { type: 'server_tool_use', id: 'srv_1' },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1' },
      { type: 'server_tool_use', id: 'srv_2' },
      { type: 'tool_use', id: 'tu_1' },
      fallbackBlock('a', 'b'),
      { type: 'thinking', thinking: '後のモデルの思考' },
      { type: 'text', text: '続き' }
    ]
    expect(echoBlocks(blocks).map((b) => b.type)).toEqual([
      'text',
      'server_tool_use',
      'web_search_tool_result',
      'thinking',
      'text'
    ])
    // 切り替わっていない回答はそのまま
    const plain = [{ type: 'thinking' }, { type: 'text' }]
    expect(echoBlocks(plain)).toBe(plain)
  })

  it('拒否したモデルと、最後に回答したモデルを取り出す', () => {
    expect(fallbackOf(null)).toBeNull()
    expect(fallbackOf(JSON.stringify([{ type: 'text', text: 'x' }]))).toBeNull()
    expect(
      fallbackOf(
        JSON.stringify([fallbackBlock('m-1', 'm-2'), fallbackBlock('m-2', 'm-3'), { type: 'text' }])
      )
    ).toEqual({ from: 'm-1', to: 'm-3' })
    expect(fallbackOf('{壊れた')).toBeNull()
  })

  it('使用量は、フォールバックした場合だけ試行ごとにモデル別に分ける', () => {
    const base = {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 2 }
    }
    // 切り替わっていない場合は上位の usage を、回答したモデルの分として使う
    expect(
      splitUsage(
        {
          model: 'm-1',
          usage: { ...base, input_tokens: 10, output_tokens: 5 } as Anthropic.Beta.BetaUsage
        },
        'm-1'
      )
    ).toEqual([
      {
        model: 'm-1',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          web_search_requests: 2
        }
      }
    ])
    const split = splitUsage(
      {
        model: 'm-2',
        usage: {
          ...base,
          input_tokens: 30,
          output_tokens: 20,
          iterations: [
            {
              type: 'message',
              model: null,
              input_tokens: 30,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0
            },
            {
              type: 'fallback_message',
              model: 'm-2',
              input_tokens: 30,
              output_tokens: 20,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 4
            }
          ]
        } as unknown as Anthropic.Beta.BetaUsage
      },
      'm-1'
    )
    // モデルが書かれていない試行は、依頼したモデルの分とする。検索の回数は回答したモデルに付ける
    expect(split).toEqual([
      {
        model: 'm-1',
        usage: {
          input_tokens: 30,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          web_search_requests: 0
        }
      },
      {
        model: 'm-2',
        usage: {
          input_tokens: 30,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 4,
          web_search_requests: 2
        }
      }
    ])
  })
})
