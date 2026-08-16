import type { Service } from 'server:core'

import type { z } from 'zod'

import type { manifestSchema } from './const'

/** The OZACO MANIFEST v1 document — inferred from {@link manifestSchema}, the single standard. */
export type Manifest = z.infer<typeof manifestSchema>
export type ManifestService = Manifest['services'][string]
export type ManifestFunction = ManifestService['functions'][string]

/** `install(Docs, options)` configuration. */
export interface DocsOptions {
  /** `manifest.app.title` (default `'Ozaco API'`). */
  readonly title?: string | undefined
  /** `manifest.app.version` (default `'0.0.0'`). */
  readonly version?: string | undefined
  readonly description?: string | undefined
  /** Advertise bearer auth in the manifest (`auth: { bearer: true }`). */
  readonly auth?: boolean | undefined
  /** Gateway mount prefix of the docs service itself (default `'/docs'`). */
  readonly path?: string | undefined
}

/** The identity block stamped into `manifest.app`, plus the auth advertisement. */
export interface DocsAppInfo {
  readonly title: string
  readonly version: string
  readonly description?: string | undefined
  readonly auth: boolean
}

/** One compile entry: a service plus the REAL prefix it is mounted under on the gateway. */
export interface DocsEntry {
  readonly prefix: string
  readonly service: Service
  /** WebSocket path of the service's realtime channel (default `<prefix>/_realtime`). */
  readonly realtimePath?: string | undefined
}
