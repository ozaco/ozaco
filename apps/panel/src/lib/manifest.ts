/**
 * Manifest surface — re-exported from `@ozaco/client`, which owns the OZACO MANIFEST v1 document
 * types and the navigation helpers. The panel keeps its own shorter names (`Manifest`, `FnEntry`,
 * `findFn`) so the UI reads the way it always did; the document itself arrives from
 * `session.manifest()`, never from a hand-rolled fetch.
 */

import type {
  ManifestDoc,
  ManifestEntry,
  ManifestFunctionDoc,
  ManifestRealtimeDoc,
  ManifestRouteDoc,
  ManifestServiceDoc,
} from '@ozaco/client'

export {
  acceptsFiles,
  classifyContentType,
  DEFAULT_DOCS_PATH,
  findEntry as findFn,
  indexManifest,
  realtimeServices,
  ssePathOf,
} from '@ozaco/client'
export type { ManifestEntry, RealtimeService, ResponseKind } from '@ozaco/client'

/** JSON Schema documents travel as opaque objects; `{ declared: true }` marks non-zod schemas. */
export type SchemaDoc = Record<string, unknown>

export type FnKind = ManifestFunctionDoc['kind']

export type Channel = 'value' | 'stream' | 'chunks' | 'parts' | 'socket'

export type RouteDoc = ManifestRouteDoc
export type RealtimeDoc = ManifestRealtimeDoc
export type FunctionDoc = ManifestFunctionDoc
export type ServiceDoc = ManifestServiceDoc
export type Manifest = ManifestDoc

export interface StatusEntry {
  readonly status: number
}

/** One function of one service, flattened for the sidebar/tab views. */
export type FnEntry = ManifestEntry
