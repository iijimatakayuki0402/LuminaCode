import type Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInMemoryDatabase } from '../../src/main/db/init'
import * as ops from '../../src/main/db/operations'
import { monthOf, monthRange, UsageService } from '../../src/main/usage/usageService'

let db: Database.Database
let dir: string
let usage: UsageService
let projectA: string
let projectB: string
const NOW = new Date(2026, 9, 15, 12).getTime()

function record(projectId: string | null, name: string, cost: number, at = NOW, input = 100): void {
  db.prepare(
    `INSERT INTO usage_records (id, project_id, project_name, model, input_tokens, output_tokens, estimated_cost, created_at)
     VALUES (?, ?, ?, 'm', ?, 10, ?, ?)`
  ).run(Math.random().toString(36), projectId, name, input, cost, at)
}

beforeEach(() => {
  db = createInMemoryDatabase()
  dir = mkdtempSync(join(tmpdir(), 'lumina-usage-'))
  usage = new UsageService(db, join(dir, 'pricing.json'), () => NOW)
  projectA = ops.createProject(db, { type: 'chat', name: 'A' }).id
  projectB = ops.createProject(db, { type: 'chat', name: 'B' }).id
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('単価表（USG-05）', () => {
  it('ファイルが無ければ既定値で作り、編集すると反映される', () => {
    expect(
      usage.estimate('claude-sonnet-5-5', {
        input_tokens: 1e6,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      })
    ).toBe(2)
    const file = JSON.parse(readFileSync(usage.pricingFile, 'utf-8'))
    expect(file._note).toContain('実際の請求額とは異なります')

    file.models['claude-sonnet-5-5'].input = 3
    writeFileSync(usage.pricingFile, JSON.stringify(file))
    utimesSync(usage.pricingFile, new Date(), new Date(Date.now() + 5000))
    expect(
      usage.estimate('claude-sonnet-5-5', {
        input_tokens: 1e6,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      })
    ).toBe(3)
  })

  it('壊れたファイルは既定値を使う', () => {
    writeFileSync(usage.pricingFile, '{')
    expect(usage.prices()['claude-sonnet-5-5'].input).toBe(2)
  })
})

describe('上限（USG-03、USG-04）', () => {
  it('上限が無ければ制限しない', () => {
    record(projectA, 'A', 999)
    expect(usage.status(projectA).level).toBe('ok')
    expect(usage.check(projectA)).toEqual({ remainingUsd: null })
  })

  it('月額上限: 80% で警告、100% で停止し、残りを返す', () => {
    usage.setLimits({ monthlyLimit: 10 })
    record(projectA, 'A', 7.9)
    expect(usage.status().level).toBe('ok')
    expect(usage.check(projectA).remainingUsd).toBeCloseTo(2.1)

    record(projectB, 'B', 0.2)
    expect(usage.status(projectA)).toMatchObject({ level: 'warning', monthTotal: 8.1 })

    record(projectA, 'A', 2)
    expect(usage.status(projectA).level).toBe('exceeded')
    expect(() => usage.check(projectA)).toThrow('上限')
  })

  it('前月の使用量は当月の上限に含めない', () => {
    usage.setLimits({ monthlyLimit: 1 })
    record(projectA, 'A', 5, new Date(2026, 8, 30).getTime())
    expect(usage.status().monthTotal).toBe(0)
  })

  it('プロジェクト別の上限', () => {
    usage.setProjectLimit(projectA, 1)
    record(projectA, 'A', 1)
    record(projectB, 'B', 5)
    expect(() => usage.check(projectA)).toThrow('上限')
    expect(usage.check(projectB)).toEqual({ remainingUsd: null })
    usage.setProjectLimit(projectA, null)
    expect(usage.check(projectA)).toEqual({ remainingUsd: null })
  })

  it('「警告のみ」では停止しない', () => {
    usage.setLimits({ monthlyLimit: 1, action: 'warn' })
    record(projectA, 'A', 2)
    expect(usage.status(projectA)).toMatchObject({ level: 'exceeded', action: 'warn' })
    expect(usage.check(projectA)).toEqual({ remainingUsd: null })
  })

  it('0 以下の上限は設定できない。null で解除できる', () => {
    expect(() => usage.setLimits({ monthlyLimit: 0 })).toThrow()
    usage.setLimits({ monthlyLimit: 5 })
    expect(usage.setLimits({ monthlyLimit: null }).monthlyLimit).toBeNull()
  })
})

describe('集計（USG-02）', () => {
  it('月別・プロジェクト別に集計し、削除したプロジェクトも名前で残る', () => {
    record(projectA, 'A', 1, NOW, 100)
    record(projectA, 'A', 2, NOW, 200)
    record(null, '削除済み', 0.5)
    record(projectB, 'B', 4, new Date(2026, 8, 3).getTime())

    const summary = usage.summary()
    expect(summary.month).toBe('2026-10')
    expect(summary.total).toMatchObject({ cost: 3.5, input_tokens: 400, requests: 3 })
    expect(summary.projects.map((p) => [p.project_name, p.totals.cost])).toEqual([
      ['A', 3],
      ['削除済み', 0.5]
    ])
    expect(summary.months.map((m) => [m.month, m.totals.cost])).toEqual([
      ['2026-10', 3.5],
      ['2026-09', 4]
    ])
    expect(usage.summary('2026-09').projects.map((p) => p.project_name)).toEqual(['B'])
    expect(usage.projectTotals(projectA).cost).toBe(3)
  })

  it('月の範囲', () => {
    expect(monthOf(NOW)).toBe('2026-10')
    const { from, to } = monthRange('2026-12')
    expect(new Date(from).getMonth()).toBe(11)
    expect(new Date(to).getFullYear()).toBe(2027)
  })
})

describe('コンテキスト使用量（CTX-01）', () => {
  it('スレッドの直近の応答で使ったトークン数（キャッシュと出力を含む）とモデルを返す', () => {
    const thread = ops.createThread(db, { project_id: projectA }).id
    const other = ops.createThread(db, { project_id: projectA }).id
    const insert = db.prepare(
      `INSERT INTO usage_records (id, project_id, project_name, thread_id, message_id, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost, created_at)
       VALUES (?, ?, 'A', ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    const message = (threadId: string): string =>
      ops.createMessage(db, { thread_id: threadId, role: 'assistant', content: 'a' }).id
    expect(usage.contextOf(thread)).toEqual({ tokens: 0, model: null })

    insert.run('u1', projectA, thread, message(thread), 'old', 100, 10, 0, 0, NOW - 2)
    insert.run('u2', projectA, thread, message(thread), 'new', 50, 20, 300, 40, NOW - 1)
    // 要約・タイトル生成など、応答に結び付かない記録は数えない
    insert.run('u3', projectA, thread, null, 'title', 9999, 1, 0, 0, NOW)
    insert.run('u4', projectA, other, message(other), 'x', 5000, 1, 0, 0, NOW)
    expect(usage.contextOf(thread)).toEqual({ tokens: 50 + 20 + 300 + 40, model: 'new' })
  })
})
