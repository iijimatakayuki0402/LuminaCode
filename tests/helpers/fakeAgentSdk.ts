/**
 * テスト用: Agent SDK の query を再現する
 * 実際の SDK と同じく、各ツール呼び出しの前に PreToolUse フックを呼び、許可された場合だけ実行して PostToolUse を呼ぶ。
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface ScriptedCall {
  tool: string
  input: Record<string, unknown>
}

export interface Script {
  calls?: ScriptedCall[]
  text?: string
  /** ツール呼び出しの後、停止されるまで待つ */
  hang?: boolean
  result?: 'success' | 'error_during_execution'
}

export interface FakeAgent {
  loadSdk: () => Promise<never>
  runs: {
    prompt: string
    options: Options
    decisions: { tool: string; decision: string; reason?: string }[]
  }[]
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>

export function fakeAgentSdk(scripts: Script[]): FakeAgent {
  const runs: FakeAgent['runs'] = []
  let index = 0

  const tool = (name: string, _d: string, _s: unknown, handler: Handler): unknown => ({
    name,
    handler
  })
  const createSdkMcpServer = (config: {
    name: string
    tools: { name: string; handler: Handler }[]
  }): unknown => config

  const query = ({ prompt, options }: { prompt: string; options: Options }): unknown => {
    const script = scripts[Math.min(index++, scripts.length - 1)]
    const run = { prompt, options, decisions: [] as FakeAgent['runs'][number]['decisions'] }
    runs.push(run)
    const signal = options.abortController!.signal
    const pre = options.hooks!.PreToolUse![0].hooks[0]
    const post = options.hooks!.PostToolUse![0].hooks[0]
    const servers = options.mcpServers as unknown as Record<
      string,
      { name: string; tools: { name: string; handler: Handler }[] }
    >
    const cwd = options.cwd!

    async function* messages(): AsyncGenerator<unknown> {
      yield { type: 'system', subtype: 'init', session_id: `session-${index}` }
      let n = 0
      for (const call of script.calls ?? []) {
        const toolUseId = `tu-${index}-${n++}`
        const output = (await pre(
          {
            hook_event_name: 'PreToolUse',
            tool_name: call.tool,
            tool_input: call.input,
            tool_use_id: toolUseId
          } as never,
          toolUseId,
          { signal }
        )) as {
          hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string }
        }
        const decision = output.hookSpecificOutput.permissionDecision
        run.decisions.push({
          tool: call.tool,
          decision,
          reason: output.hookSpecificOutput.permissionDecisionReason
        })
        if (signal.aborted) break
        if (decision !== 'allow') continue
        let response: unknown = 'ok'
        if (call.tool === 'Write') {
          const path = resolve(cwd, String(call.input['file_path']))
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, String(call.input['content']))
        } else if (call.tool === 'Edit') {
          const path = resolve(cwd, String(call.input['file_path']))
          const text = readFileSync(path, 'utf-8')
          writeFileSync(
            path,
            text.replace(String(call.input['old_string']), String(call.input['new_string']))
          )
        } else if (call.tool === 'Read') {
          response = readFileSync(resolve(cwd, String(call.input['file_path'])), 'utf-8')
        } else if (call.tool.startsWith('mcp__lumina__')) {
          const handler = servers['lumina'].tools.find(
            (t) => `mcp__lumina__${t.name}` === call.tool
          )!.handler
          response = (await handler(call.input)).content[0].text
        }
        await post(
          {
            hook_event_name: 'PostToolUse',
            tool_name: call.tool,
            tool_input: call.input,
            tool_use_id: toolUseId,
            tool_response: response
          } as never,
          toolUseId,
          { signal }
        )
      }
      if (script.hang) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          signal.addEventListener('abort', () => resolve())
        })
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          total_cost_usd: 0,
          usage: {},
          errors: []
        }
        return
      }
      if (script.text) {
        yield {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: script.text } }
        }
        yield {
          type: 'assistant',
          uuid: `uuid-${index}`,
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: script.text }] }
        }
      }
      const success = (script.result ?? 'success') === 'success'
      yield {
        type: 'result',
        subtype: success ? 'success' : 'error_during_execution',
        is_error: !success,
        total_cost_usd: 0.0123,
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        },
        errors: []
      }
    }

    const iterator = messages()
    return Object.assign(iterator, { interrupt: async () => undefined })
  }

  return {
    loadSdk: (async () => ({ query, tool, createSdkMcpServer })) as unknown as () => Promise<never>,
    runs
  }
}
