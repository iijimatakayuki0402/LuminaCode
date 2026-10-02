import { describe, expect, it } from 'vitest'
import { isTrustedSenderUrl } from '../src/main/security/ipcSender'

const prod = { rendererFileUrl: 'file:///C:/Program%20Files/Lumina%20Code/out/renderer/index.html' }
const dev = { ...prod, devServerUrl: 'http://localhost:5173' }

describe('isTrustedSenderUrl', () => {
  it('本番: 同梱の index.html からの呼び出しを許可する', () => {
    expect(isTrustedSenderUrl(prod.rendererFileUrl, prod)).toBe(true)
    expect(isTrustedSenderUrl(`${prod.rendererFileUrl}#/projects`, prod)).toBe(true)
    // Windows のパスは大文字・小文字を区別しない
    expect(
      isTrustedSenderUrl('file:///c:/program%20files/lumina%20code/out/renderer/index.html', prod)
    ).toBe(true)
  })

  it('本番: 他のファイルや外部 URL は拒否する', () => {
    expect(isTrustedSenderUrl('file:///C:/Users/me/Downloads/evil.html', prod)).toBe(false)
    expect(isTrustedSenderUrl('https://example.com/', prod)).toBe(false)
    expect(isTrustedSenderUrl('http://localhost:5173/', prod)).toBe(false)
  })

  it('開発: dev サーバーの origin のみ許可する', () => {
    expect(isTrustedSenderUrl('http://localhost:5173/', dev)).toBe(true)
    expect(isTrustedSenderUrl('http://localhost:5173/index.html?x=1', dev)).toBe(true)
    expect(isTrustedSenderUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isTrustedSenderUrl('https://localhost:5173/', dev)).toBe(false)
  })

  it('URL が無い・不正な場合は拒否する', () => {
    expect(isTrustedSenderUrl(undefined, prod)).toBe(false)
    expect(isTrustedSenderUrl('', prod)).toBe(false)
    expect(isTrustedSenderUrl('not a url', prod)).toBe(false)
  })
})
