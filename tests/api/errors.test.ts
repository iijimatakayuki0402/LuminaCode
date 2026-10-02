import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toApiRequestError } from '../../src/main/api/errors'
import { apiError } from '../helpers/fakeAnthropic'

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('toApiRequestError（要件 6.14）', () => {
  it.each([
    [401, 'authentication_error', 'auth', 'API キー'],
    [403, 'permission_error', 'permission', 'API キー'],
    [402, 'billing_error', 'billing', 'コンソール'],
    [404, 'not_found_error', 'not_found', 'モデル一覧'],
    [413, 'request_too_large', 'too_large', '添付ファイル'],
    [429, 'rate_limit_error', 'rate_limit', '待って'],
    [529, 'overloaded_error', 'overloaded', '混み合って'],
    [500, 'api_error', 'server', '待って'],
    [400, 'invalid_request_error', 'bad_request', '受け付けられません']
  ])('%i %s → %s', (status, type, kind, text) => {
    const error = toApiRequestError(apiError(status, type), 'test')
    expect(error.kind).toBe(kind)
    expect(error.status).toBe(status)
    expect(error.message).toContain(text)
  })

  it('接続エラーはオフライン、タイムアウトは timeout', () => {
    expect(toApiRequestError(new Anthropic.APIConnectionError({ message: 'x' }), 't').kind).toBe(
      'offline'
    )
    expect(toApiRequestError(new Anthropic.APIConnectionTimeoutError(), 't').kind).toBe('timeout')
  })

  it('SDK 以外の例外は unknown', () => {
    expect(toApiRequestError(new Error('boom'), 't').kind).toBe('unknown')
  })

  it('ログには種別とステータスだけを出す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    toApiRequestError(apiError(401, 'authentication_error'), 'models.list')
    expect(warn).toHaveBeenCalledWith('[api] models.list failed: kind=auth status=401')
  })
})
