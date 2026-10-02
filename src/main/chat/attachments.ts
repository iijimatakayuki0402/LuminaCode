/**
 * 添付ファイル（要件 ATT-01〜05）
 * 送信前に「仮置き」としてアプリの保存先へコピーし（ATT-04）、送信時にメッセージへ紐付ける。
 * 元のファイルが移動・削除されても会話は壊れない。
 */

import type Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { AttachmentInfo, AttachmentKind } from '@shared/types'
import { ValidationError, type AttachmentRecord } from '../db/operations'

export const ATTACHMENT_LIMITS = {
  /** 1 ファイルの上限（ATT-02） */
  maxFileBytes: 30 * 1024 * 1024,
  /** 1 メッセージあたりのファイル数（ATT-02） */
  maxFiles: 10,
  /** API の画像 1 枚あたりの上限 */
  maxImageBytes: 5 * 1024 * 1024,
  /** API の 1 リクエストあたりの上限（base64 で約 4/3 倍になる） */
  maxRequestBytes: 32 * 1024 * 1024,
  /** サムネイルを作る画像の上限 */
  maxPreviewBytes: 5 * 1024 * 1024
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

// テキスト系（ATT-01: txt、md、csv、json、xml、html、ソースコード各種）
const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown csv tsv json jsonl xml html htm css scss less yaml yml toml ini cfg conf log ' +
    'js jsx mjs cjs ts tsx vue svelte py rb php java kt kts scala go rs c h cc cpp hpp cs swift ' +
    'm sql sh bash zsh ps1 psm1 bat cmd r lua pl dart ex exs erl hs fs clj tex rst gitignore env'
  )
    .split(' ')
    .map((e) => `.${e}`)
)

const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods'
])

export function classifyFile(filename: string): { kind: AttachmentKind; mime_type: string } {
  const ext = extname(filename).toLowerCase() || `.${basename(filename).toLowerCase()}`
  if (IMAGE_TYPES[ext]) return { kind: 'image', mime_type: IMAGE_TYPES[ext] }
  if (ext === '.pdf') return { kind: 'pdf', mime_type: 'application/pdf' }
  if (TEXT_EXTENSIONS.has(ext)) return { kind: 'text', mime_type: 'text/plain' }
  if (OFFICE_EXTENSIONS.has(ext)) {
    throw new ValidationError(
      `Office 文書（${ext}）は添付できません。テキストや PDF に変換してから添付してください。`
    )
  }
  throw new ValidationError(`この形式のファイルは添付できません: ${filename}`)
}

const formatMb = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)}MB`

function checkContent(filename: string, kind: AttachmentKind, bytes: Buffer): void {
  if (bytes.length === 0) throw new ValidationError(`空のファイルは添付できません: ${filename}`)
  if (bytes.length > ATTACHMENT_LIMITS.maxFileBytes) {
    throw new ValidationError(
      `ファイルが大きすぎます（上限 ${formatMb(ATTACHMENT_LIMITS.maxFileBytes)}）: ${filename}`
    )
  }
  if (kind === 'image' && bytes.length > ATTACHMENT_LIMITS.maxImageBytes) {
    throw new ValidationError(
      `画像が大きすぎます（API の上限 ${formatMb(ATTACHMENT_LIMITS.maxImageBytes)}）: ${filename}`
    )
  }
  if (kind === 'text') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new ValidationError(`UTF-8 のテキストファイルのみ添付できます: ${filename}`)
    }
  }
}

interface Staged extends AttachmentInfo {
  path: string
}

/**
 * 添付ファイルの保管
 *   <dir>/staging/<id>   送信前の仮置き
 *   <dir>/<messageId>/<id> 送信済み（DB の stored_path は <dir> からの相対パス）
 */
export class AttachmentStore {
  private readonly staged = new Map<string, Staged>()

  constructor(private readonly dir: string) {}

  private get stagingDir(): string {
    return join(this.dir, 'staging')
  }

  /** ファイルのパスから仮置きする（ファイル選択ダイアログ・ドラッグ＆ドロップ） */
  stageFromPath(path: string): AttachmentInfo {
    const filename = basename(path)
    const { kind, mime_type } = classifyFile(filename)
    if (!statSync(path).isFile()) throw new ValidationError(`ファイルではありません: ${filename}`)
    return this.stage(filename, kind, mime_type, readFileSync(path))
  }

  /** データから仮置きする（クリップボードの画像の貼り付け） */
  stageFromData(filename: string, data: Uint8Array): AttachmentInfo {
    const { kind, mime_type } = classifyFile(filename)
    return this.stage(filename, kind, mime_type, Buffer.from(data))
  }

  private stage(
    filename: string,
    kind: AttachmentKind,
    mime_type: string,
    bytes: Buffer
  ): AttachmentInfo {
    checkContent(filename, kind, bytes)
    const id = randomUUID()
    const path = join(this.stagingDir, id)
    mkdirSync(this.stagingDir, { recursive: true })
    writeFileSync(path, bytes)

    const info: AttachmentInfo = { id, filename, mime_type, size_bytes: bytes.length, kind }
    if (kind === 'image' && bytes.length <= ATTACHMENT_LIMITS.maxPreviewBytes) {
      info.preview = `data:${mime_type};base64,${bytes.toString('base64')}`
    }
    this.staged.set(id, { ...info, path })
    return info
  }

  discard(id: string): void {
    const staged = this.staged.get(id)
    if (!staged) return
    rmSync(staged.path, { force: true })
    this.staged.delete(id)
  }

  /** 仮置きのファイル（送信前に検証する） */
  getStaged(ids: string[]): AttachmentInfo[] {
    return ids.map((id) => {
      const staged = this.staged.get(id)
      if (!staged)
        throw new ValidationError('添付ファイルが見つかりません。もう一度追加してください。')
      return staged
    })
  }

  /**
   * 仮置きのファイルをメッセージの保存先へ移し、DB に記録する内容を返す
   */
  commit(messageId: string, ids: string[]): Omit<AttachmentRecord, 'created_at'>[] {
    if (ids.length === 0) return []
    const targetDir = join(this.dir, messageId)
    mkdirSync(targetDir, { recursive: true })
    return this.getStaged(ids).map((info) => {
      const staged = this.staged.get(info.id)!
      renameSync(staged.path, join(targetDir, info.id))
      this.staged.delete(info.id)
      return {
        id: info.id,
        message_id: messageId,
        filename: info.filename,
        stored_path: join(messageId, info.id),
        mime_type: info.mime_type,
        size_bytes: info.size_bytes
      }
    })
  }

  /**
   * 読み込んだ添付ファイルを保存する（EXP-01）
   * 形式はファイル名から判定し直す（書き出しファイルの MIME タイプは信用しない）
   */
  writeFor(
    messageId: string,
    filename: string,
    _declaredMime: string,
    bytes: Buffer
  ): Omit<AttachmentRecord, 'created_at'> {
    const { kind, mime_type } = classifyFile(filename)
    checkContent(filename, kind, bytes)
    const id = randomUUID()
    mkdirSync(join(this.dir, messageId), { recursive: true })
    writeFileSync(join(this.dir, messageId, id), bytes)
    return {
      id,
      message_id: messageId,
      filename,
      stored_path: join(messageId, id),
      mime_type,
      size_bytes: bytes.length
    }
  }

  /** 既存の添付ファイルを別のメッセージへ複製する（CHT-14 の編集・再送信） */
  copyTo(messageId: string, source: AttachmentRecord): Omit<AttachmentRecord, 'created_at'> {
    const id = randomUUID()
    const targetDir = join(this.dir, messageId)
    mkdirSync(targetDir, { recursive: true })
    copyFileSync(join(this.dir, source.stored_path), join(targetDir, id))
    return {
      id,
      message_id: messageId,
      filename: source.filename,
      stored_path: join(messageId, id),
      mime_type: source.mime_type,
      size_bytes: source.size_bytes
    }
  }

  read(record: Pick<AttachmentRecord, 'stored_path'>): Buffer {
    return readFileSync(join(this.dir, record.stored_path))
  }

  /** 起動時に、前回の仮置きを片付ける */
  clearStaging(): void {
    rmSync(this.stagingDir, { recursive: true, force: true })
  }

  /** 削除されたメッセージの添付ファイルを片付ける（存在するメッセージ ID 以外のフォルダを消す） */
  pruneOrphans(messageExists: (id: string) => boolean): number {
    let entries: string[]
    try {
      entries = readdirSync(this.dir)
    } catch {
      return 0
    }
    let removed = 0
    for (const name of entries) {
      if (name === 'staging' || messageExists(name)) continue
      rmSync(join(this.dir, name), { recursive: true, force: true })
      removed++
    }
    return removed
  }
}

export function kindOfMime(mime: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  return 'text'
}

/**
 * 添付ファイルを API の内容ブロックにする（同じファイルからは毎回同じバイト列になる）
 */
export function toContentBlock(
  record: Pick<AttachmentRecord, 'filename' | 'mime_type'>,
  bytes: Buffer
): Anthropic.Beta.BetaContentBlockParam {
  const kind = kindOfMime(record.mime_type)
  if (kind === 'image') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: record.mime_type as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        data: bytes.toString('base64')
      }
    }
  }
  if (kind === 'pdf') {
    return {
      type: 'document',
      title: record.filename,
      source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') }
    }
  }
  return {
    type: 'document',
    title: record.filename,
    source: { type: 'text', media_type: 'text/plain', data: bytes.toString('utf-8') }
  }
}
