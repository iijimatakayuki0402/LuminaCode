/**
 * 更新の確認と適用（要件 CMN-03、10.4）
 * - 配信元は electron-builder.yml の publish で設定する（ビルド時に app-update.yml が作られる）。
 *   未設定のときは「未設定」とし、外部には接続しない。
 * - 確認は起動時と設定画面から。ダウンロード・適用は、どちらもユーザーの操作で行う。
 * Electron に依存しない形にし、electron-updater の autoUpdater は外から渡す（テストのため）。
 */

import type { UpdateStatus } from '@shared/types'
import { ValidationError } from '../db/operations'

interface UpdateInfoLike {
  version: string
  releaseNotes?: string | readonly { version: string; note: string | null }[] | null
}

/** electron-updater の autoUpdater のうち、使う部分 */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: UpdateInfoLike } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', listener: (info: { percent: number }) => void): unknown
}

export interface UpdateServiceOptions {
  /** 配信元が設定されているか（app-update.yml があるか） */
  configured: boolean
  currentVersion: string
  /** 配信元が未設定なら呼ばれない */
  createUpdater: () => Updater
  /** 状態が変わったら renderer に知らせる */
  emit: (status: UpdateStatus) => void
  /** インストーラーを起動する前の準備（生成中の応答を停止して保存する） */
  prepareInstall?: () => Promise<void>
  now?: () => number
}

/** 更新内容を画面に出せる文字列にする（HTML のタグは取り除く） */
export function formatReleaseNotes(notes: UpdateInfoLike['releaseNotes']): string | null {
  if (!notes) return null
  const text =
    typeof notes === 'string'
      ? notes
      : notes.map((n) => `${n.version}\n${n.note ?? ''}`).join('\n\n')
  const plain = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return plain === '' ? null : plain.slice(0, 5000)
}

export class UpdateService {
  private status: UpdateStatus
  private updater: Updater | null = null
  private readonly now: () => number

  constructor(private readonly options: UpdateServiceOptions) {
    this.now = options.now ?? Date.now
    this.status = {
      state: options.configured ? 'idle' : 'unconfigured',
      currentVersion: options.currentVersion,
      version: null,
      releaseNotes: null,
      percent: null,
      checkedAt: null,
      error: null
    }
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  /** 新しいバージョンがあるか確認する（ダウンロードはしない） */
  async check(): Promise<UpdateStatus> {
    const updater = this.getUpdater()
    if (!updater) return this.status
    // 確認・ダウンロードの途中や、ダウンロード済みのときは、状態を変えない
    if (['checking', 'downloading', 'downloaded'].includes(this.status.state)) return this.status
    this.update({ state: 'checking', error: null })
    try {
      const result = await updater.checkForUpdates()
      const checkedAt = this.now()
      if (result?.isUpdateAvailable) {
        this.update({
          state: 'available',
          version: result.updateInfo.version,
          releaseNotes: formatReleaseNotes(result.updateInfo.releaseNotes),
          checkedAt
        })
      } else {
        this.update({ state: 'latest', version: null, releaseNotes: null, checkedAt })
      }
    } catch (error) {
      this.fail(
        error,
        'error',
        '更新を確認できませんでした。ネットワークの状態を確認してください。'
      )
    }
    return this.status
  }

  /** ユーザーの承認後にダウンロードする */
  async download(): Promise<UpdateStatus> {
    const updater = this.getUpdater()
    if (!updater) return this.status
    if (this.status.state !== 'available') {
      throw new ValidationError('ダウンロードできる更新がありません。')
    }
    this.update({ state: 'downloading', percent: 0, error: null })
    try {
      await updater.downloadUpdate()
      this.update({ state: 'downloaded', percent: 100 })
    } catch (error) {
      // 再度ダウンロードできるよう、available に戻してエラーを示す
      this.fail(error, 'available', 'ダウンロードに失敗しました。もう一度お試しください。')
    }
    return this.status
  }

  /** ユーザーの承認後に、アプリを終了して更新をインストールする */
  async install(): Promise<void> {
    const updater = this.getUpdater()
    if (!updater || this.status.state !== 'downloaded') {
      throw new ValidationError('インストールできる更新がありません。')
    }
    // インストーラーはアプリを終了させるため、先に生成中の応答を保存しておく
    await this.options.prepareInstall?.()
    updater.quitAndInstall(false, true)
  }

  private getUpdater(): Updater | null {
    if (!this.options.configured) return null
    if (!this.updater) {
      const updater = this.options.createUpdater()
      // CMN-03: 自動ではダウンロード・インストールしない（ユーザーの承認後に行う）
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = false
      updater.on('download-progress', (info) => {
        if (this.status.state === 'downloading') this.update({ percent: Math.floor(info.percent) })
      })
      this.updater = updater
    }
    return this.updater
  }

  private fail(error: unknown, state: 'error' | 'available', message: string): void {
    console.warn('[update] failed:', (error as Error).message)
    this.update({ state, percent: null, error: message })
  }

  private update(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.options.emit(this.status)
  }
}
