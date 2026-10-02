/**
 * ウィンドウの大きさ・位置の記憶（要件 CMN-05）
 * Electron に依存しない形にし、画面の情報は外から渡す（テストのため）。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  bounds: Rect
  maximized: boolean
}

export const WINDOW_STATE_KEY = 'window_state'
export const DEFAULT_SIZE = { width: 1200, height: 800 }
const MIN_SIZE = { width: 800, height: 560 }

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 保存した内容を読む（壊れていれば null） */
export function parseWindowState(raw: string | null): WindowState | null {
  if (!raw) return null
  try {
    const data = JSON.parse(raw) as { bounds?: Partial<Rect>; maximized?: unknown }
    const b = data.bounds
    if (!b || !num(b.x) || !num(b.y) || !num(b.width) || !num(b.height)) return null
    return {
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      maximized: data.maximized === true
    }
  } catch {
    return null
  }
}

/**
 * 復元する大きさ・位置。モニターの構成が変わって画面の外に出る場合は、位置を指定しない（中央に表示する）
 * workAreas: 各モニターの作業領域（タスクバーを除く）
 */
export function restoreBounds(
  state: WindowState | null,
  workAreas: Rect[]
): Partial<Rect> & { width: number; height: number } {
  if (!state) return { ...DEFAULT_SIZE }
  const { x, y } = state.bounds
  const width = Math.max(MIN_SIZE.width, Math.round(state.bounds.width))
  const height = Math.max(MIN_SIZE.height, Math.round(state.bounds.height))
  // タイトルバーの付近（左上から 100×40）がどこかの作業領域に入っていれば、操作できる位置とみなす
  const reachable = workAreas.some(
    (a) => x + 100 > a.x && x < a.x + a.width && y + 40 > a.y && y < a.y + a.height
  )
  if (!reachable) {
    const area = workAreas[0]
    return area
      ? { width: Math.min(width, area.width), height: Math.min(height, area.height) }
      : { width, height }
  }
  return { x: Math.round(x), y: Math.round(y), width, height }
}
