/** Wire headers the client reads/writes (mirrors the server's). */
export enum HEADERS {
  requestId = 'x-request-id',
  brand = 'oz-brand',
  error = 'oz-error',
}

export const DEFAULT_DOCS_PATH = '/docs'
export const DEFAULT_REALTIME_SUFFIX = '/_realtime'
export const DEFAULT_TIMEOUT_MS = 30_000
