/**
 * Windows のトースト通知（要件 COW-07: Cowork の完了・エラー・確認待ちを、アプリが非アクティブのときに知らせる）
 * 通知には会話の内容を含めない（プロジェクト名・スレッド名と状態だけ）。
 */

import type { ChatEvent, ProjectType } from '@shared/types'

export interface ThreadLabel {
  projectName: string
  /** 手動または AI が付けたタイトル。最初の発言から作ったタイトル（会話の内容そのもの）は渡さない */
  threadTitle: string | null
  projectType: ProjectType
}

const CATEGORY: Record<string, string> = {
  write: 'ファイルの書き込み',
  delete: 'ファイルの削除',
  command: 'コマンドの実行',
  web: 'Web へのアクセス',
  mcp: 'MCP のツール'
}

/**
 * 通知する内容。通知しない出来事は null
 */
export function notificationFor(
  event: ChatEvent,
  lookup: (threadId: string) => ThreadLabel | null
): { title: string; body: string } | null {
  if (event.type !== 'permission' && event.type !== 'finished') return null
  const label = lookup(event.threadId)
  if (!label || label.projectType !== 'cowork') return null
  const where = label.threadTitle ? `${label.projectName}／${label.threadTitle}` : label.projectName
  if (event.type === 'permission') {
    return {
      title: '確認が必要です',
      body: `${where}: ${CATEGORY[event.request.category] ?? '操作'}の確認を待っています。`
    }
  }
  if (event.message.status === 'complete') return { title: '作業が完了しました', body: where }
  if (event.message.status === 'error') {
    return { title: '作業がエラーで終了しました', body: where }
  }
  return null // 停止はユーザー自身の操作のため通知しない
}
