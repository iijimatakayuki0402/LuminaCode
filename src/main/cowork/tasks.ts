/**
 * todo の進捗（要件 COW-13）
 * 現在の Claude Code は TodoWrite の代わりに Task 系のツール（TaskCreate／TaskUpdate／TaskList／TaskGet）で
 * 作業の一覧を管理する。ツールの入力と結果（PostToolUse の tool_response）から、画面に出す一覧を組み立てる。
 */

import type { TodoItem } from '@shared/types'

export const TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']

type Status = TodoItem['status']
const STATUSES = new Set<string>(['pending', 'in_progress', 'completed'])

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const obj = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

/** tool_response は構造化された値のことも、JSON の文字列のこともある */
function parse(response: unknown): Record<string, unknown> | undefined {
  if (typeof response !== 'string') return obj(response)
  try {
    return obj(JSON.parse(response))
  } catch {
    return undefined
  }
}

interface Task {
  subject: string
  activeForm: string | undefined
  status: Status
}

/**
 * スレッドごとの作業の一覧（作業 ID の順に並べる）
 */
export class TaskTracker {
  private readonly tasks = new Map<string, Task>()

  /**
   * ツールの実行結果を反映する。一覧が変わった場合は新しい一覧を、それ以外は null を返す
   */
  apply(toolName: string, input: unknown, response: unknown): TodoItem[] | null {
    const args = obj(input) ?? {}
    const result = parse(response)
    if (toolName === 'TaskCreate') {
      const id = str(obj(result?.['task'])?.['id'])
      const subject = str(args['subject'])
      if (!id || !subject) return null
      this.tasks.set(id, { subject, activeForm: str(args['activeForm']), status: 'pending' })
    } else if (toolName === 'TaskUpdate') {
      const id = str(args['taskId'])
      const task = id ? this.tasks.get(id) : undefined
      if (!id || !task || result?.['success'] === false) return null
      const status = str(args['status'])
      if (status === 'deleted') {
        this.tasks.delete(id)
      } else {
        if (status && STATUSES.has(status)) task.status = status as Status
        task.subject = str(args['subject']) ?? task.subject
        task.activeForm = str(args['activeForm']) ?? task.activeForm
      }
    } else if (toolName === 'TaskList' || toolName === 'TaskGet') {
      const list =
        toolName === 'TaskList'
          ? Array.isArray(result?.['tasks'])
            ? (result['tasks'] as unknown[])
            : []
          : [result?.['task']]
      let changed = false
      for (const item of list.map(obj)) {
        const id = str(item?.['id'])
        const subject = str(item?.['subject'])
        const status = str(item?.['status'])
        if (!id || !subject || !status || !STATUSES.has(status)) continue
        const task = this.tasks.get(id)
        this.tasks.set(id, { subject, activeForm: task?.activeForm, status: status as Status })
        changed = true
      }
      if (!changed) return null
    } else {
      return null
    }
    return this.list()
  }

  list(): TodoItem[] {
    return [...this.tasks.entries()]
      .sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b))
      .map(([, t]) => ({
        content: t.subject,
        status: t.status,
        activeForm: t.activeForm ?? t.subject
      }))
  }
}
