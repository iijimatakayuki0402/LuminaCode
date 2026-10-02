/**
 * IPC 引数の実行時検証
 * renderer からの値は型定義どおりとは限らないため、main 側で形式を確認してから使う。
 * 想定外のキーは拒否する（意図しない列の更新を防ぐ）。
 */

import type {
  CreateProjectInput,
  CreateThreadInput,
  PermissionMode,
  ProjectType,
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

const bool: Check<boolean> = (value, name) =>
  typeof value === 'boolean' ? value : fail(name, '真偽値')

const oneOf =
  <T extends string>(values: readonly T[]): Check<T> =>
  (value, name) =>
    values.includes(value as T) ? (value as T) : fail(name, values.join(' / ') + ' のいずれか')

const optional =
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

export const updateThreadInput = object<UpdateThreadInput>({
  title: optional(str),
  model: optional(str),
  extended_thinking: optional(bool)
})
