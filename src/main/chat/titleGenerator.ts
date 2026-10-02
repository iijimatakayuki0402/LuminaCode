/**
 * スレッドのタイトルの自動生成（要件 THR-03: 最初のやり取りから自動生成する。手動で変更できる）
 * 最初の応答が完了したあとに、軽量なモデル（Haiku 系統の最新）で短いタイトルを作る。
 * 手動で変更されたタイトルは上書きしない。失敗しても会話には影響させない。
 */

import type Database from 'better-sqlite3'
import type { ChatEvent } from '@shared/types'
import type { ClientFactory } from '../api/client'
import { toApiRequestError } from '../api/errors'
import * as ops from '../db/operations'
import type { ModelService } from '../models/modelService'
import type { UsageService } from '../usage/usageService'

const MAX_INPUT_CHARS = 2000
const MAX_TITLE_CHARS = 30

export interface TitleGeneratorDeps {
  db: Database.Database
  modelService: ModelService
  getApiKey: () => string | null
  createClient: ClientFactory
  usage?: Pick<UsageService, 'check' | 'estimate'>
  emit: (event: ChatEvent) => void
}

const clip = (text: string): string =>
  text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}…` : text

/** 生成結果を整える（引用符・記号・改行を除き、長さを抑える） */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (!line) return null
  const title = line
    .replace(/^(タイトル|title)\s*[:：]\s*/i, '')
    .replace(/^[「『"'“#*\s]+|[」』"'”*\s。]+$/g, '')
    .trim()
  if (!title) return null
  const chars = [...title]
  return chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS).join('')}…` : title
}

export class TitleGenerator {
  constructor(private readonly deps: TitleGeneratorDeps) {}

  /** 軽量なモデル（一覧のうち Haiku 系統の最新）。無ければ会話のモデルを使う */
  private pickModel(fallback: string): string {
    const models = this.deps.modelService.cachedModels()
    const light = [...models]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .find((m) => m.id.toLowerCase().includes('haiku'))
    return light?.id ?? fallback
  }

  async generate(
    threadId: string,
    userText: string,
    assistantText: string,
    fallbackModel: string
  ): Promise<void> {
    const { db } = this.deps
    const thread = ops.getThread(db, threadId)
    const apiKey = this.deps.getApiKey()
    if (!thread || thread.title_source !== 'auto' || apiKey === null) return
    const project = ops.getProject(db, thread.project_id)
    if (!project) return
    try {
      this.deps.usage?.check(project.id)
    } catch {
      return // 上限に達している場合は作らない
    }

    const model = this.pickModel(fallbackModel)
    const info = this.deps.modelService.getModelInfo(model)
    try {
      const client = this.deps.createClient(apiKey, { maxRetries: 1 })
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        ...(info?.effort_levels.includes('low')
          ? { output_config: { effort: 'low' as const } }
          : {}),
        messages: [
          {
            role: 'user',
            content: `次の会話の内容を表す、20 文字以内の日本語のタイトルを 1 つだけ出力してください。説明・引用符・記号は付けないでください。\n\n<user>\n${clip(userText)}\n</user>\n<assistant>\n${clip(assistantText)}\n</assistant>`
          }
        ]
      })
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('')
      const title = cleanTitle(text)

      const usage = {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0
      }
      ops.insertUsageRecord(db, {
        project_id: project.id,
        project_name: project.name,
        thread_id: threadId,
        message_id: null,
        model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
        cache_write_tokens: usage.cache_creation_input_tokens,
        estimated_cost: this.deps.usage?.estimate(model, usage) ?? 0
      })

      // 生成中に手動で変更されていれば上書きしない
      if (!title || ops.getThread(db, threadId)?.title_source !== 'auto') return
      ops.updateThread(db, threadId, { title, title_source: 'ai' })
      this.deps.emit({ type: 'threadUpdated', threadId })
    } catch (error) {
      toApiRequestError(error, 'title.generate')
    }
  }
}
