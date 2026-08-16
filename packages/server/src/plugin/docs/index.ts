/**
 * `server:docs` — the OZACO MANIFEST v1 (a typed, WebSocket-capable API document standard — the
 * OpenAPI replacement of this stack and the client codegen source) plus a first-party,
 * CDN-free docs panel served straight from the gateway.
 */
export { manifestSchema } from './const'
export { Docs } from './definition'
export { DocsErrors } from './errors'
export type {
  DocsAppInfo,
  DocsEntry,
  DocsOptions,
  Manifest,
  ManifestFunction,
  ManifestService,
} from './types'
