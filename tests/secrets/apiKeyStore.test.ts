import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ValidationError } from '../../src/main/db/operations'
import {
  ApiKeyStore,
  maskApiKey,
  normalizeApiKey,
  type SecretCipher
} from '../../src/main/secrets/apiKeyStore'

const KEY = 'sk-ant-api03-EXAMPLEKEY-abcd'

// 実際の DPAPI の代わりに、内容が平文で残らない可逆変換を使う
const fakeCipher = (available = true): SecretCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => {
    const text = b.toString()
    if (!text.startsWith('ENC:')) throw new Error('decrypt failed')
    return Buffer.from(text.slice(4), 'base64').toString()
  }
})

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumina-key-'))
  file = join(dir, 'sub', 'api-key.bin')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('ApiKeyStore', () => {
  it('暗号化して保存し、平文はファイルに残らない（KEY-03、受け入れ基準 2）', () => {
    const store = new ApiKeyStore(file, fakeCipher())
    store.save(KEY)

    expect(readFileSync(file).toString()).not.toContain(KEY)
    expect(new ApiKeyStore(file, fakeCipher()).get()).toBe(KEY)
  })

  it('状態はマスク表示のみを返す', () => {
    const store = new ApiKeyStore(file, fakeCipher())
    expect(store.status()).toEqual({ configured: false, masked: null, encryptionAvailable: true })

    store.save(KEY)
    const status = store.status()
    expect(status).toEqual({ configured: true, masked: '••••••••abcd', encryptionAvailable: true })
    expect(JSON.stringify(status)).not.toContain('EXAMPLEKEY')
  })

  it('削除できる（KEY-04）', () => {
    const store = new ApiKeyStore(file, fakeCipher())
    store.save(KEY)
    store.delete()

    expect(existsSync(file)).toBe(false)
    expect(store.get()).toBeNull()
    expect(new ApiKeyStore(file, fakeCipher()).get()).toBeNull()
  })

  it('暗号化が使えない環境では保存しない', () => {
    const store = new ApiKeyStore(file, fakeCipher(false))
    expect(() => store.save(KEY)).toThrow(ValidationError)
    expect(existsSync(file)).toBe(false)
  })

  it('復号できないファイルは未設定として扱う', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new ApiKeyStore(file, fakeCipher())
    store.save(KEY)
    writeFileSync(file, 'broken')

    expect(new ApiKeyStore(file, fakeCipher()).get()).toBeNull()
  })
})

describe('normalizeApiKey / maskApiKey', () => {
  it('前後の空白を除く', () => {
    expect(normalizeApiKey(`  ${KEY}\n`)).toBe(KEY)
  })

  it('空・空白を含む・制御文字や全角を含むキーは拒否する', () => {
    for (const input of ['', '   ', 'sk-ant abc', 'sk-ant-\u0001', 'sk-ant-あいう']) {
      expect(() => normalizeApiKey(input)).toThrow(ValidationError)
    }
  })

  it('末尾 4 文字だけを表示する', () => {
    expect(maskApiKey(KEY)).toBe('••••••••abcd')
  })
})
