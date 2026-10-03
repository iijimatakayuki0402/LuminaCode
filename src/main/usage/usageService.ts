/**
 * 使用量・コスト管理（要件 USG-01〜05）
 *   - 単価表は設定ファイル（%APPDATA%\LuminaCode\pricing.json）で更新できる（USG-05）
 *   - 月額上限とプロジェクト別上限（当月の累計）。80% で警告、100% で新規リクエストを停止（USG-03、USG-04）
 */

import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  CacheEffect,
  ProjectUsage,
  UsageLimits,
  UsageStatus,
  UsageSummary,
  UsageTotals
} from '@shared/types'
import {
  DEFAULT_PRICES,
  estimateCost,
  findPrice,
  type ModelPrice,
  type TokenUsage
} from '../chat/pricing'
import { deleteSetting, getSetting, setSetting, ValidationError } from '../db/operations'
import { toCsv } from '../data/csv'

/** 警告を出す割合（USG-04） */
export const WARNING_RATIO = 0.8

const MONTHLY_KEY = 'usage.monthlyLimit'
const ACTION_KEY = 'usage.limitAction'
const PROJECT_KEY = (projectId: string): string => `usage.projectLimit.${projectId}`

const EMPTY: UsageTotals = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost: 0,
  requests: 0
}

/** 現地時刻での月（YYYY-MM）の開始・終了（epoch ms） */
export function monthRange(month: string): { from: number; to: number } {
  const [y, m] = month.split('-').map(Number)
  return { from: new Date(y, m - 1, 1).getTime(), to: new Date(y, m, 1).getTime() }
}

/** 2026-10-03 01:50:00 の形（現地時刻） */
export function localDateTime(epoch: number): string {
  const d = new Date(epoch)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function monthOf(epoch: number): string {
  const d = new Date(epoch)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const TOTALS_SQL = `COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(estimated_cost), 0) AS cost,
  COUNT(*) AS requests`

interface PricingFile {
  _note?: string
  models: Record<string, ModelPrice>
}

export class UsageService {
  private cache: { mtime: number; prices: Record<string, ModelPrice> } | null = null

  constructor(
    private readonly db: Database.Database,
    private readonly pricingPath: string,
    private readonly now: () => number = Date.now
  ) {}

  // ========================================
  // 単価表（USG-05）
  // ========================================

  /** 単価表を読む。ファイルが無ければ既定値で作る。読めない場合は既定値を使う */
  prices(): Record<string, ModelPrice> {
    try {
      if (!existsSync(this.pricingPath)) {
        mkdirSync(dirname(this.pricingPath), { recursive: true })
        const file: PricingFile = {
          _note:
            '概算コストの単価表（USD / 100 万トークン）。モデル ID の前方一致で使われます。実際の請求額とは異なります。',
          models: DEFAULT_PRICES
        }
        writeFileSync(this.pricingPath, JSON.stringify(file, null, 2))
      }
      const mtime = statSync(this.pricingPath).mtimeMs
      if (this.cache?.mtime === mtime) return this.cache.prices
      const parsed = JSON.parse(readFileSync(this.pricingPath, 'utf-8')) as PricingFile
      const prices: Record<string, ModelPrice> = {}
      for (const [prefix, p] of Object.entries(parsed.models ?? {})) {
        if (
          [p.input, p.output, p.cacheWrite, p.cacheRead].every(
            (v) => typeof v === 'number' && v >= 0
          )
        ) {
          prices[prefix] = p
        }
      }
      this.cache = { mtime, prices }
      return prices
    } catch (error) {
      console.warn(
        '[usage] pricing file could not be read; using defaults:',
        (error as Error).message
      )
      return DEFAULT_PRICES
    }
  }

  estimate(model: string, usage: TokenUsage): number | null {
    return estimateCost(model, usage, this.prices())
  }

  /** モデルの単価（USD / 100 万トークン）。不明なら null */
  priceOf(model: string): ModelPrice | null {
    return findPrice(model, this.prices())
  }

  get pricingFile(): string {
    return this.pricingPath
  }

  // ========================================
  // 上限（USG-03、USG-04）
  // ========================================

  getLimits(): UsageLimits {
    const monthly = Number(getSetting(this.db, MONTHLY_KEY))
    return {
      monthlyLimit: Number.isFinite(monthly) && monthly > 0 ? monthly : null,
      action: getSetting(this.db, ACTION_KEY) === 'warn' ? 'warn' : 'stop'
    }
  }

  setLimits(input: Partial<UsageLimits>): UsageLimits {
    if (input.monthlyLimit !== undefined) {
      if (input.monthlyLimit === null) deleteSetting(this.db, MONTHLY_KEY)
      else if (input.monthlyLimit > 0) setSetting(this.db, MONTHLY_KEY, String(input.monthlyLimit))
      else throw new ValidationError('上限は 0 より大きい金額で指定してください。')
    }
    if (input.action) setSetting(this.db, ACTION_KEY, input.action)
    return this.getLimits()
  }

  getProjectLimit(projectId: string): number | null {
    const value = Number(getSetting(this.db, PROJECT_KEY(projectId)))
    return Number.isFinite(value) && value > 0 ? value : null
  }

  setProjectLimit(projectId: string, limit: number | null): void {
    if (limit === null) deleteSetting(this.db, PROJECT_KEY(projectId))
    else if (limit > 0) setSetting(this.db, PROJECT_KEY(projectId), String(limit))
    else throw new ValidationError('上限は 0 より大きい金額で指定してください。')
  }

  private totals(where: string, params: (string | number)[]): UsageTotals {
    return (
      (this.db.prepare(`SELECT ${TOTALS_SQL} FROM usage_records WHERE ${where}`).get(...params) as
        UsageTotals | undefined) ?? EMPTY
    )
  }

  /** 当月の使用量と上限に対する状態 */
  status(projectId?: string): UsageStatus {
    const month = monthOf(this.now())
    const { from, to } = monthRange(month)
    const { monthlyLimit, action } = this.getLimits()
    const monthTotal = this.totals('created_at >= ? AND created_at < ?', [from, to]).cost
    const projectLimit = projectId ? this.getProjectLimit(projectId) : null
    const projectTotal = projectId
      ? this.totals('project_id = ? AND created_at >= ? AND created_at < ?', [projectId, from, to])
          .cost
      : 0
    const ratios = [
      monthlyLimit ? monthTotal / monthlyLimit : 0,
      projectLimit ? projectTotal / projectLimit : 0
    ]
    const ratio = Math.max(...ratios)
    return {
      month,
      monthTotal,
      monthlyLimit,
      projectTotal,
      projectLimit,
      action,
      ratio,
      level: ratio >= 1 ? 'exceeded' : ratio >= WARNING_RATIO ? 'warning' : 'ok'
    }
  }

  /**
   * 新規リクエストの前に呼ぶ（USG-04: 100% に達したら停止。設定で「警告のみ」にできる）
   * 戻り値は、上限までの残り（Cowork の実行中の上限に使う）。上限が無ければ null
   */
  check(projectId: string): { remainingUsd: number | null } {
    const s = this.status(projectId)
    if (s.level === 'exceeded' && s.action === 'stop') {
      throw new ValidationError(
        '使用量が上限に達したため、新しいリクエストを停止しています。使用量画面または設定画面で上限を引き上げるか、解除してください。'
      )
    }
    if (s.action === 'warn') return { remainingUsd: null }
    const remaining = [
      s.monthlyLimit !== null ? s.monthlyLimit - s.monthTotal : null,
      s.projectLimit !== null ? s.projectLimit - s.projectTotal : null
    ].filter((v): v is number => v !== null)
    return { remainingUsd: remaining.length > 0 ? Math.max(0, Math.min(...remaining)) : null }
  }

  // ========================================
  // 集計（USG-02）
  // ========================================

  /**
   * スレッドのコンテキスト使用量（CTX-01）: 直近の応答のリクエストで使ったトークン数
   * 次のリクエストでは、それに応答の出力も加わるため、出力も含める
   */
  contextOf(threadId: string): { tokens: number; model: string | null } {
    const row = this.db
      .prepare(
        `SELECT input_tokens + cache_read_tokens + cache_write_tokens + output_tokens AS tokens, model
         FROM usage_records WHERE thread_id = ? AND message_id IS NOT NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(threadId) as { tokens: number; model: string } | undefined
    return { tokens: row?.tokens ?? 0, model: row?.model ?? null }
  }

  threadTotals(threadId: string): UsageTotals {
    return this.totals('thread_id = ?', [threadId])
  }

  projectTotals(projectId: string): UsageTotals {
    return this.totals('project_id = ?', [projectId])
  }

  /**
   * 利用履歴の CSV（USG-06）。month を省略すると全期間。日時は表計算ソフトで扱いやすいよう現地時刻で出す
   */
  historyCsv(month?: string): string {
    const range = month ? monthRange(month) : null
    const rows = this.db
      .prepare(
        `SELECT u.created_at, u.project_name, t.title AS thread_title, u.model, u.input_tokens,
           u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.estimated_cost
         FROM usage_records u LEFT JOIN threads t ON t.id = u.thread_id
         ${range ? 'WHERE u.created_at >= ? AND u.created_at < ?' : ''}
         ORDER BY u.created_at, u.rowid`
      )
      .all(...(range ? [range.from, range.to] : [])) as {
      created_at: number
      project_name: string
      thread_title: string | null
      model: string
      input_tokens: number
      output_tokens: number
      cache_read_tokens: number
      cache_write_tokens: number
      estimated_cost: number
    }[]
    return toCsv(
      [
        '日時',
        'プロジェクト',
        'スレッド',
        'モデル',
        '入力トークン',
        '出力トークン',
        'キャッシュ読み込みトークン',
        'キャッシュ書き込みトークン',
        '概算コスト（USD）'
      ],
      rows.map((r) => [
        localDateTime(r.created_at),
        r.project_name,
        r.thread_title ?? '',
        r.model,
        r.input_tokens,
        r.output_tokens,
        r.cache_read_tokens,
        r.cache_write_tokens,
        r.estimated_cost.toFixed(6)
      ])
    )
  }

  /**
   * プロンプトキャッシュの効果（USG-07）
   * 節約額 = 読み込み × (入力単価 − 読み込み単価) − 書き込み × (書き込み単価 − 入力単価)。単価はモデルごと
   */
  cacheEffect(from: number, to: number): CacheEffect {
    const rows = this.db
      .prepare(
        `SELECT model, COALESCE(SUM(input_tokens), 0) AS input,
           COALESCE(SUM(cache_read_tokens), 0) AS read, COALESCE(SUM(cache_write_tokens), 0) AS write
         FROM usage_records WHERE created_at >= ? AND created_at < ? GROUP BY model`
      )
      .all(from, to) as { model: string; input: number; read: number; write: number }[]
    let saved = 0
    let input = 0
    let read = 0
    let write = 0
    for (const r of rows) {
      input += r.input
      read += r.read
      write += r.write
      const price = this.priceOf(r.model)
      if (!price) continue // 単価が不明なモデルは金額に含めない（トークン数とヒット率には含める）
      saved +=
        (r.read * (price.input - price.cacheRead) - r.write * (price.cacheWrite - price.input)) /
        1_000_000
    }
    const all = input + read + write
    return {
      savedUsd: saved,
      hitRate: all > 0 ? read / all : null,
      readTokens: read,
      writeTokens: write
    }
  }

  summary(month = monthOf(this.now())): UsageSummary {
    const { from, to } = monthRange(month)
    const months = this.db
      .prepare(
        `SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch', 'localtime') AS month, ${TOTALS_SQL}
         FROM usage_records GROUP BY month ORDER BY month DESC LIMIT 24`
      )
      .all() as (UsageTotals & { month: string })[]
    const projects = this.db
      .prepare(
        `SELECT project_id, project_name, ${TOTALS_SQL}
         FROM usage_records WHERE created_at >= ? AND created_at < ?
         GROUP BY COALESCE(project_id, project_name) ORDER BY cost DESC`
      )
      .all(from, to) as (UsageTotals & { project_id: string | null; project_name: string })[]
    const limits = this.db
      .prepare("SELECT key, value FROM settings WHERE key LIKE 'usage.projectLimit.%'")
      .all() as { key: string; value: string }[]
    const projectLimits: Record<string, number> = {}
    for (const { key, value } of limits) {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0) projectLimits[key.slice('usage.projectLimit.'.length)] = n
    }
    return {
      month,
      projectLimits,
      total: this.totals('created_at >= ? AND created_at < ?', [from, to]),
      cache: this.cacheEffect(from, to),
      months: months.map(({ month: m, ...totals }) => ({ month: m, totals })),
      projects: projects.map(({ project_id, project_name, ...totals }): ProjectUsage => ({
        project_id,
        project_name,
        totals,
        limit: project_id ? this.getProjectLimit(project_id) : null
      }))
    }
  }
}
