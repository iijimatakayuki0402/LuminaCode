import { useEffect, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import { unwrap } from './ipc'

/**
 * モデル一覧（キャッシュ）と全体の既定モデル。取得に失敗しても画面は表示を続ける
 */
export function useModels(): { models: ModelInfo[]; defaultModel: string | null } {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [defaultModel, setDefaultModel] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    Promise.all([unwrap(window.lumina.models.list()), unwrap(window.lumina.models.getDefault())])
      .then(([list, current]) => {
        if (!active) return
        setModels(list.models)
        setDefaultModel(current)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  return { models, defaultModel }
}
