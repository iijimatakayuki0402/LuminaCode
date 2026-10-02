import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@shared/types'
import {
  formatReleaseNotes,
  UpdateService,
  type Updater
} from '../../src/main/update/updateService'

class FakeUpdater implements Updater {
  autoDownload = true
  autoInstallOnAppQuit = true
  result: Awaited<ReturnType<Updater['checkForUpdates']>> = null
  checkError: Error | null = null
  downloadError: Error | null = null
  installed: [boolean | undefined, boolean | undefined] | null = null
  progress: ((info: { percent: number }) => void) | null = null

  async checkForUpdates(): ReturnType<Updater['checkForUpdates']> {
    if (this.checkError) throw this.checkError
    return this.result
  }
  async downloadUpdate(): Promise<unknown> {
    this.progress?.({ percent: 42.7 })
    if (this.downloadError) throw this.downloadError
    return []
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installed = [isSilent, isForceRunAfter]
  }
  on(_event: 'download-progress', listener: (info: { percent: number }) => void): this {
    this.progress = listener
    return this
  }
}

let updater: FakeUpdater
let events: UpdateStatus[]
let created: number

const service = (configured = true, prepareInstall?: () => Promise<void>): UpdateService =>
  new UpdateService({
    configured,
    currentVersion: '0.1.0',
    createUpdater: () => {
      created++
      return updater
    },
    emit: (s) => events.push(s),
    prepareInstall,
    now: () => 1000
  })

beforeEach(() => {
  updater = new FakeUpdater()
  events = []
  created = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('配信元が未設定（CMN-03）', () => {
  it('確認しても外部に接続せず、未設定のまま', async () => {
    const s = service(false)
    expect(s.getStatus()).toMatchObject({ state: 'unconfigured', currentVersion: '0.1.0' })
    expect((await s.check()).state).toBe('unconfigured')
    expect(created).toBe(0)
    expect(events).toEqual([])
  })

  it('ダウンロード・インストールはできない', async () => {
    const s = service(false)
    expect((await s.download()).state).toBe('unconfigured')
    await expect(s.install()).rejects.toThrow('インストールできる更新がありません')
  })
})

describe('確認', () => {
  it('自動ではダウンロード・インストールしない設定にする', async () => {
    await service().check()
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  it('新しいバージョンがあれば available（更新内容も返す）', async () => {
    updater.result = {
      isUpdateAvailable: true,
      updateInfo: { version: '0.2.0', releaseNotes: '<p>改善 &amp; 修正</p>' }
    }
    const s = service()
    const status = await s.check()
    expect(status).toMatchObject({
      state: 'available',
      version: '0.2.0',
      releaseNotes: '改善 & 修正',
      checkedAt: 1000
    })
    expect(events.map((e) => e.state)).toEqual(['checking', 'available'])
  })

  it('最新なら latest', async () => {
    updater.result = { isUpdateAvailable: false, updateInfo: { version: '0.1.0' } }
    expect((await service().check()).state).toBe('latest')
  })

  it('失敗したら error（詳細はログにのみ出す）', async () => {
    updater.checkError = new Error('net::ERR_INTERNET_DISCONNECTED https://example.com/latest.yml')
    const status = await service().check()
    expect(status.state).toBe('error')
    expect(status.error).not.toContain('example.com')
  })

  it('ダウンロード済みなら確認し直さない', async () => {
    updater.result = { isUpdateAvailable: true, updateInfo: { version: '0.2.0' } }
    const s = service()
    await s.check()
    await s.download()
    updater.result = { isUpdateAvailable: false, updateInfo: { version: '0.1.0' } }
    expect((await s.check()).state).toBe('downloaded')
  })
})

describe('ダウンロードとインストール（ユーザーの承認後）', () => {
  beforeEach(() => {
    updater.result = { isUpdateAvailable: true, updateInfo: { version: '0.2.0' } }
  })

  it('確認前はダウンロードできない', async () => {
    await expect(service().download()).rejects.toThrow('ダウンロードできる更新がありません')
  })

  it('ダウンロードの進捗を知らせ、完了したら downloaded', async () => {
    const s = service()
    await s.check()
    const status = await s.download()
    expect(status).toMatchObject({ state: 'downloaded', percent: 100 })
    expect(events.map((e) => [e.state, e.percent])).toContainEqual(['downloading', 42])
  })

  it('ダウンロードに失敗したら、やり直せるよう available に戻す', async () => {
    updater.downloadError = new Error('sha512 checksum mismatch')
    const s = service()
    await s.check()
    const status = await s.download()
    expect(status).toMatchObject({ state: 'available', percent: null })
    expect(status.error).toContain('ダウンロードに失敗')
  })

  it('ダウンロード前はインストールできない', async () => {
    const s = service()
    await s.check()
    await expect(s.install()).rejects.toThrow('インストールできる更新がありません')
    expect(updater.installed).toBeNull()
  })

  it('生成中の応答を保存してから、インストーラーを起動する', async () => {
    const order: string[] = []
    const s = service(true, async () => {
      order.push('prepare')
    })
    await s.check()
    await s.download()
    const original = updater.quitAndInstall.bind(updater)
    updater.quitAndInstall = (a, b) => {
      order.push('install')
      original(a, b)
    }
    await s.install()
    expect(order).toEqual(['prepare', 'install'])
    // 画面付きでインストールし、終わったらアプリを起動する
    expect(updater.installed).toEqual([false, true])
  })
})

describe('更新内容の整形', () => {
  it('配列は版ごとにまとめ、空なら null', () => {
    expect(
      formatReleaseNotes([
        { version: '0.3.0', note: 'C' },
        { version: '0.2.0', note: null }
      ])
    ).toBe('0.3.0\nC\n\n0.2.0')
    expect(formatReleaseNotes('<p></p>')).toBeNull()
    expect(formatReleaseNotes(null)).toBeNull()
  })

  it('HTML のタグを取り除き、改行を残す', () => {
    expect(formatReleaseNotes('<h2>新機能</h2><ul><li>A</li><li>B<br>C</li></ul>')).toBe(
      '新機能\nA\nB\nC'
    )
  })
})
