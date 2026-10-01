export interface LuminaApi {
  versions: { electron: string; chrome: string }
}

declare global {
  interface Window {
    lumina: LuminaApi
  }
}
