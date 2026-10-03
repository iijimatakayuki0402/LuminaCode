/**
 * IPC 引数の実行時検証
 * renderer からの値は型定義どおりとは限らないため、main 側で形式を確認してから使う。
 * 想定外のキーは拒否する（意図しない列の更新を防ぐ）。
 */

import { ACCENTS, MODES } from '@shared/theme'
import { EFFORT_LEVELS, THREAD_COLORS, type EffortLevel, type ThreadColor } from '@shared/types'
import type {
  Appearance,
  CoworkFolderAccess,
  ChatPrefs,
  CoworkPrefs,
  CoworkProjectSettings,
  CreateProjectInput,
  McpServer,
  EditAndResendInput,
  ListProjectsOptions,
  CreateThreadInput,
  PermissionMode,
  ProjectType,
  PermissionResponse,
  SearchQuery,
  SendMessageInput,
  SnippetInput,
  ToolCategory,
  ToolEventFilter,
  UsageLimits,
  UpdateProjectInput,
  UpdateThreadInput
} from '@shared/types'
import { InvalidArgumentError } from './errors'

type Check<T> = (value: unknown, name: string) => T

const fail = (name: string, expected: string): never => {
  throw new InvalidArgumentError(`${name} は ${expected} である必要があります`)
}

export const str: Check<string> = (value, name) =>
  typeof value === 'string' ? value : fail(name, '文字列')

export const id: Check<string> = (value, name) =>
  typeof value === 'string' && value.length > 0 && value.length <= 64
    ? value
    : fail(name, 'ID 文字列')

export const bool: Check<boolean> = (value, name) =>
  typeof value === 'boolean' ? value : fail(name, '真偽値')

const oneOf =
  <T extends string>(values: readonly T[]): Check<T> =>
  (value, name) =>
    values.includes(value as T) ? (value as T) : fail(name, values.join(' / ') + ' のいずれか')

export const optional =
  <T>(check: Check<T>): Check<T | undefined> =>
  (value, name) =>
    value === undefined ? undefined : check(value, name)

type Shape<T> = { [K in keyof T]-?: Check<T[K]> }

const object =
  <T>(shape: Shape<T>): Check<T> =>
  (value, name) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(name, 'オブジェクト')
    }
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (!(key in shape)) throw new InvalidArgumentError(`${name}.${key} は指定できません`)
    }
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(shape) as (keyof T & string)[]) {
      const checked = shape[key](record[key], `${name}.${key}`)
      if (checked !== undefined) result[key] = checked
    }
    return result as T
  }

const projectType = oneOf<ProjectType>(['chat', 'cowork'])
const permissionMode = oneOf<PermissionMode>(['confirm_each', 'auto_edit', 'plan_only'])

export const createProjectInput = object<CreateProjectInput>({
  type: projectType,
  name: str,
  custom_instructions: optional(str),
  work_folder: optional(str),
  model: optional(str),
  permission_mode: optional(permissionMode)
})

export const updateProjectInput = object<UpdateProjectInput>({
  name: optional(str),
  custom_instructions: optional(str),
  work_folder: optional(str),
  model: optional(str),
  permission_mode: optional(permissionMode),
  pinned: optional(bool),
  archived: optional(bool)
})

export const createThreadInput = object<CreateThreadInput>({
  project_id: id,
  title: optional(str),
  model: optional(str),
  extended_thinking: optional(bool)
})

export const listProjectsOptions = object<ListProjectsOptions>({
  includeArchived: optional(bool)
})

export const appearanceInput = object<Partial<Appearance>>({
  mode: optional(oneOf(MODES)),
  accent: optional(oneOf(ACCENTS))
})

const array =
  <T>(check: Check<T>, max: number): Check<T[]> =>
  (value, name) => {
    if (!Array.isArray(value) || value.length > max) return fail(name, `${max} 件以内の配列`)
    return value.map((item, i) => check(item, `${name}[${i}]`))
  }

const ids = array(id, 20)

export const paths = array(str, 20)

export const bytes: Check<Uint8Array> = (value, name) =>
  value instanceof Uint8Array ? value : fail(name, 'バイト列')

export const sendMessageInput = object<SendMessageInput>({
  threadId: id,
  content: str,
  attachmentIds: ids
})

export const editAndResendInput = object<EditAndResendInput>({
  userMessageId: id,
  content: str,
  keepAttachmentIds: ids,
  attachmentIds: ids
})

export const chatPrefsInput = object<Partial<ChatPrefs>>({
  sendKey: optional(oneOf(['enter', 'ctrl_enter'] as const)),
  fallback: optional(bool)
})

export const permissionResponse = oneOf<PermissionResponse>(['once', 'thread', 'project', 'deny'])
export const scope = oneOf(['thread', 'project'] as const)
export const exportFormat = oneOf(['csv', 'json'] as const)

const toolCategory = oneOf<ToolCategory>([
  'read',
  'write',
  'delete',
  'command',
  'plan',
  'web',
  'other'
])

export const num: Check<number> = (value, name) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fail(name, '数値')

export const toolEventFilter = object<ToolEventFilter>({
  projectId: optional(id),
  category: optional(toolCategory),
  query: optional(str),
  from: optional(num),
  to: optional(num),
  limit: optional(num)
})

const strings = array(str, 200)

export const coworkPrefsInput = object<Partial<CoworkPrefs>>({
  denyPatterns: optional(strings),
  allowCommands: optional(strings)
})

export const month: Check<string> = (value, name) =>
  typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : fail(name, 'YYYY-MM')

export const limit: Check<number | null> = (value, name) =>
  value === null ? null : num(value, name)

export const usageLimitsInput = object<Partial<UsageLimits>>({
  monthlyLimit: optional(limit),
  action: optional(oneOf(['stop', 'warn'] as const))
})

export const searchQuery = object<SearchQuery>({
  text: str,
  projectId: optional(id),
  projectType: optional(oneOf<ProjectType>(['chat', 'cowork']))
})

const record = (name: string, value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(name, 'オブジェクト')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 50) return fail(name, '50 件以内')
  return Object.fromEntries(entries.map(([k, v]) => [k, str(v, `${name}.${k}`)]))
}

export const mcpServer: Check<McpServer> = (value, name) => {
  if (typeof value !== 'object' || value === null) return fail(name, 'オブジェクト')
  const v = value as Record<string, unknown>
  if (v['type'] === 'stdio') {
    return {
      name: str(v['name'], `${name}.name`),
      type: 'stdio',
      command: str(v['command'], `${name}.command`),
      args: array(str, 50)(v['args'] ?? [], `${name}.args`),
      env: record(`${name}.env`, v['env'] ?? {})
    }
  }
  if (v['type'] === 'http') {
    return {
      name: str(v['name'], `${name}.name`),
      type: 'http',
      url: str(v['url'], `${name}.url`),
      headers: record(`${name}.headers`, v['headers'] ?? {})
    }
  }
  return fail(`${name}.type`, 'stdio / http のいずれか')
}

export const coworkSettingsInput = object<Partial<CoworkProjectSettings>>({
  webAccess: optional(bool),
  gitSnapshots: optional(bool)
})

export const updateThreadInput = object<UpdateThreadInput>({
  title: optional(str),
  model: optional(str),
  extended_thinking: optional(bool),
  effort: optional(oneOf<EffortLevel | ''>([...EFFORT_LEVELS, ''])),
  color: optional(oneOf<ThreadColor | ''>([...THREAD_COLORS, ''])),
  // 数と長さの上限は保存時に確かめる（THR-06。画面に表示できる文言にするため）
  tags: optional(array(str, 50))
})

export const snippetInput = object<SnippetInput>({
  id: optional(id),
  name: str,
  content: str
})

export const folderAccess = oneOf<CoworkFolderAccess>(['read', 'write'])
