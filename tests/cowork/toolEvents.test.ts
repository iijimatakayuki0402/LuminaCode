import { describe, expect, it } from 'vitest'
import { summarizeToolResponse } from '../../src/main/cowork/toolEvents'

describe('summarizeToolResponse（SEC-25）', () => {
  it('MCP ツールは本文、コマンドは出力、ファイル操作は完了だけを残す', () => {
    expect(
      summarizeToolResponse('mcp__lumina__delete_files', [
        { type: 'text', text: '1 件を退避しました' }
      ])
    ).toBe('1 件を退避しました')
    expect(
      summarizeToolResponse('Bash', { stdout: 'a.txt\n', stderr: '', interrupted: false })
    ).toBe('a.txt\n')
    expect(summarizeToolResponse('Bash', { stdout: '', stderr: '' })).toBe('（出力なし）')
    expect(
      summarizeToolResponse('Write', { type: 'create', filePath: 'x', content: '秘密の内容' })
    ).toBe('完了（create）')
    expect(
      summarizeToolResponse('Read', { type: 'text', file: { content: '秘密の内容' } })
    ).not.toContain('秘密')
    expect(summarizeToolResponse('Glob', 'a.ts\nb.ts')).toBe('a.ts\nb.ts')
  })
})
