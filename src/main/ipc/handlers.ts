/**
 * IPC ハンドラー
 * Electron に依存しない形で定義し、登録（register.ts）と分けてテストできるようにする。
 */

import type Database from 'better-sqlite3'
import type { AppInfo, IpcChannel, IpcReturn } from '@shared/ipc'
import * as ops from '../db/operations'
import { NotFoundError } from './errors'
import * as v from './validate'

export type IpcHandlers = {
  [C in IpcChannel]: (...args: unknown[]) => IpcReturn<C> | Promise<IpcReturn<C>>
}

export interface HandlerDeps {
  db: Database.Database
  appInfo: AppInfo
}

function found<T>(value: T | null, message: string): T {
  if (value === null) throw new NotFoundError(message)
  return value
}

function deleted(changed: boolean, message: string): void {
  if (!changed) throw new NotFoundError(message)
}

const PROJECT_NOT_FOUND = 'プロジェクトが見つかりません。'
const THREAD_NOT_FOUND = 'スレッドが見つかりません。'

export function createHandlers({ db, appInfo }: HandlerDeps): IpcHandlers {
  return {
    'app:getInfo': () => appInfo,

    'projects:list': () => ops.listProjects(db),
    'projects:get': (projectId) =>
      found(ops.getProject(db, v.id(projectId, 'id')), PROJECT_NOT_FOUND),
    'projects:create': (input) => ops.createProject(db, v.createProjectInput(input, 'input')),
    'projects:update': (projectId, input) =>
      found(
        ops.updateProject(db, v.id(projectId, 'id'), v.updateProjectInput(input, 'input')),
        PROJECT_NOT_FOUND
      ),
    'projects:delete': (projectId) =>
      deleted(ops.deleteProject(db, v.id(projectId, 'id')), PROJECT_NOT_FOUND),

    'threads:listByProject': (projectId) =>
      ops.listThreadsByProject(db, v.id(projectId, 'projectId')),
    'threads:create': (input) => {
      const checked = v.createThreadInput(input, 'input')
      found(ops.getProject(db, checked.project_id), PROJECT_NOT_FOUND)
      return ops.createThread(db, checked)
    },
    'threads:update': (threadId, input) =>
      found(
        ops.updateThread(db, v.id(threadId, 'id'), v.updateThreadInput(input, 'input')),
        THREAD_NOT_FOUND
      ),
    'threads:delete': (threadId) =>
      deleted(ops.deleteThread(db, v.id(threadId, 'id')), THREAD_NOT_FOUND),
    'threads:markOpened': (threadId) =>
      deleted(ops.markThreadOpened(db, v.id(threadId, 'id')), THREAD_NOT_FOUND),
    'threads:getLastOpened': (projectId) =>
      ops.getLastOpenedThread(db, v.id(projectId, 'projectId')),

    'messages:listByThread': (threadId) => ops.listMessagesByThread(db, v.id(threadId, 'threadId'))
  }
}
