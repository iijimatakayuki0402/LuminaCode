import type { LuminaApi } from '@shared/ipc'

declare global {
  interface Window {
    lumina: LuminaApi
  }
}
