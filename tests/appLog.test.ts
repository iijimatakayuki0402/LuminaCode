import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_LOG_BYTES, redact, writeLog } from '../src/main/logging/appLog'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumina-log-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('アプリログ（6.14、SEC-31）', () => {
  it('API キーを伏せる', () => {
    expect(redact('key sk-ant-api03-abcdefghijklmnop end')).toBe('key sk-ant-*** end')
    expect(redact('{"x-api-key":"secret123"}')).toBe('{"x-api-key":"***"}')
    expect(redact('apiKey=abcd')).toBe('apiKey=***')
  })

  it('日時・種別を付けて追記し、Error は名前と本文だけを書く', () => {
    const file = join(dir, 'app.log')
    writeLog(file, 'ERROR', [
      '[api] failed:',
      Object.assign(new Error('boom sk-ant-api03-zzzzzzzzzzzz'), { name: 'APIError' })
    ])
    const text = readFileSync(file, 'utf-8')
    expect(text).toMatch(
      /^\d{4}-\d{2}-\d{2}T.* \[ERROR\] \[api\] failed: APIError: boom sk-ant-\*\*\*\n$/
    )
  })

  it('上限を超えたら世代交代する', () => {
    const file = join(dir, 'app.log')
    writeFileSync(file, 'x'.repeat(MAX_LOG_BYTES))
    writeLog(file, 'WARN', ['next'])
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toContain('next')
  })
})
