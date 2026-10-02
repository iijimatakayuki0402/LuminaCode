/**
 * API キーの保管（要件 KEY-03、SEC-30）
 * OS の暗号化（Electron safeStorage。Windows では DPAPI）で暗号化したファイルとして保存する。
 * 復号したキーは main プロセス内にのみ保持し、renderer にはマスク表示だけを渡す。
 * 暗号化が使えない環境では保存しない（平文で保存しない）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ApiKeyStatus } from '@shared/types'
import { ValidationError } from '../db/operations'

/** safeStorage と同じ形のインターフェース（テストで差し替えられるようにする） */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

const MASK_VISIBLE = 4

export function maskApiKey(apiKey: string): string {
  return `••••••••${apiKey.slice(-MASK_VISIBLE)}`
}

/**
 * 入力されたキーの形式を確認して整える（前後の空白は除く）
 * 実際に有効かどうかは疎通テストで確認する
 */
export function normalizeApiKey(input: string): string {
  const apiKey = input.trim()
  if (apiKey === '') throw new ValidationError('API キーを入力してください。')
  if (/\s/.test(apiKey) || apiKey.length > 512 || !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new ValidationError('API キーの形式が正しくありません。')
  }
  return apiKey
}

export class ApiKeyStore {
  private cached: string | null | undefined

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher
  ) {}

  status(): ApiKeyStatus {
    const apiKey = this.get()
    return {
      configured: apiKey !== null,
      masked: apiKey === null ? null : maskApiKey(apiKey),
      encryptionAvailable: this.cipher.isEncryptionAvailable()
    }
  }

  /** 保存済みのキー（main プロセス内でのみ使う）。未設定・復号失敗時は null */
  get(): string | null {
    if (this.cached !== undefined) return this.cached
    this.cached = this.load()
    return this.cached
  }

  save(apiKey: string): void {
    if (!this.cipher.isEncryptionAvailable()) {
      throw new ValidationError(
        'この環境では API キーを暗号化して保存できないため、保存を中止しました。'
      )
    }
    const encrypted = this.cipher.encryptString(apiKey)
    mkdirSync(dirname(this.filePath), { recursive: true })
    // 書き込み途中で異常終了しても既存のキーが壊れないよう、一時ファイルから置き換える
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, encrypted)
    renameSync(tmp, this.filePath)
    this.cached = apiKey
  }

  delete(): void {
    rmSync(this.filePath, { force: true })
    this.cached = null
  }

  private load(): string | null {
    if (!existsSync(this.filePath)) return null
    try {
      return this.cipher.decryptString(readFileSync(this.filePath))
    } catch (error) {
      // 別ユーザー・別 PC で暗号化されたファイルなど。未設定として扱い、再設定を促す
      console.warn('[apiKey] failed to decrypt stored key:', (error as Error).name)
      return null
    }
  }
}
