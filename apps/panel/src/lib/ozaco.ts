// oxlint-disable import/exports-last
/**
 * The panel's OWN data code — a cached client per connection, nothing else. Everything
 * wire-level and tool-generic (schema forms, manifest navigation, send/watch/loadManifest,
 * failure shaping) is the client's shared inspector API, re-exported here as the one-stop
 * import for the views.
 */
import type { ClientDef, ManifestDef } from '@ozaco/client'
import { connectClient } from '@ozaco/client'

import type { Connection } from './config'

export {
  coerceField,
  exampleOf,
  fieldsOf,
  findEntry,
  groupsOf,
  loadManifest,
  matches,
  orphanSockets,
  pathParams,
  send,
  watch,
  wireFailureOf as failureOf,
} from '@ozaco/client'
export type {
  Chunk,
  Entry,
  Field,
  InFlight,
  Outcome,
  SendRequest,
  ServiceGroup,
  Watching,
  WatchHandlers,
  WireFailure,
} from '@ozaco/client'

export type Manifest = ManifestDef.Manifest
export type Action = ManifestDef.Action
export type Socket = ManifestDef.Socket
export type WatchFrame = ClientDef.WatchFrame<Record<string, unknown>>

type Handle = ClientDef.ConnectedHandle<Record<string, Record<string, ClientDef.Ref>>>

let current: { key: string; client: Promise<Handle> } | null = null

/** ONE client per connection (base · docsPath · token), rebuilt when any of those change. */
export const clientOf = (connection: Connection): Promise<Handle> => {
  const key = `${connection.base}|${connection.docsPath}|${connection.token ?? ''}`

  if (current?.key !== key) {
    void current?.client.then(client => client.$close()).catch(() => {})
    current = {
      key,
      client: connectClient({
        url: connection.base,
        docsPath: connection.docsPath,
        token: () => connection.token ?? undefined,
      }),
    }
  }

  return current.client
}
