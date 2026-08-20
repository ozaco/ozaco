// oxlint-disable import/exports-last
/**
 * OZACO MANIFEST v1 navigation. Pure functions over the document `@ozaco/server`'s docs plugin
 * serves — the client uses them for addressing, tooling uses them to enumerate what a server
 * exposes. Nothing here fetches: hand it the document from {@link ClientSession.manifest}.
 */

import type {
  ManifestDoc,
  ManifestFunctionDoc,
  ManifestRealtimeDoc,
  ManifestRouteDoc,
} from './types'

/** One function of one service, flattened and denormalized for list/tree rendering. */
export interface ManifestEntry {
  /** `<service>.<key>` — the stable identity of a function across the whole document. */
  readonly id: string
  readonly service: string
  readonly key: string
  readonly kind: ManifestFunctionDoc['kind']
  readonly title: string | undefined
  readonly description: string | undefined
  readonly route: ManifestRouteDoc | undefined
  readonly args: Record<string, unknown> | undefined
  readonly returns: Record<string, unknown> | undefined
  readonly channels: {
    readonly input: readonly string[]
    readonly output: readonly string[]
  }
  readonly errors: Record<string, { readonly status: number }>
  readonly tags: readonly string[]
  /** The owning service's mount prefix. */
  readonly prefix: string
  /** The owning service's realtime block, when it has one. */
  readonly realtime: ManifestRealtimeDoc | undefined
}

const NO_CHANNELS = { input: [], output: [] } as const

/** Flatten every service function into one ordered list (document order preserved). */
export const indexManifest = (manifest: ManifestDoc): ManifestEntry[] => {
  const entries: ManifestEntry[] = []

  for (const [service, doc] of Object.entries(manifest.services)) {
    for (const [key, fn] of Object.entries(doc.functions)) {
      entries.push({
        id: `${service}.${key}`,
        service,
        key,
        kind: fn.kind,
        title: fn.title,
        description: fn.description,
        route: fn.route,
        args: fn.args,
        returns: fn.returns,
        channels: fn.channels ?? NO_CHANNELS,
        errors: fn.errors ?? {},
        tags: fn.tags ?? [],
        prefix: doc.prefix,
        realtime: doc.realtime,
      })
    }
  }

  return entries
}

export const findEntry = (
  entries: readonly ManifestEntry[],
  id: string,
): ManifestEntry | undefined => entries.find(entry => entry.id === id)

/** A service that exposes a realtime channel, with its watchable function keys. */
export interface RealtimeService {
  readonly service: string
  readonly prefix: string
  readonly realtime: ManifestRealtimeDoc
  /** Function keys of the service — the candidates for a watch frame's `fn`. */
  readonly functions: readonly string[]
}

export const realtimeServices = (manifest: ManifestDoc): RealtimeService[] => {
  const services: RealtimeService[] = []

  for (const [service, doc] of Object.entries(manifest.services)) {
    if (doc.realtime) {
      services.push({
        service,
        prefix: doc.prefix,
        realtime: doc.realtime,
        functions: Object.keys(doc.functions),
      })
    }
  }

  return services
}

/** Whether a function accepts multipart uploads (`parts` on its input wire). */
export const acceptsFiles = (entry: ManifestEntry): boolean =>
  entry.channels.input.includes('parts')

/** The SSE flavor path of a realtime block (`GET <path>/sse?fn=&args=&since=`). */
export const ssePathOf = (realtime: ManifestRealtimeDoc): string => `${realtime.path}/sse`
