// oxlint-disable import/exports-last
/**
 * The panel's OWN data code — a cached client per connection, nothing else. Everything
 * wire-level and tool-generic (schema forms, manifest navigation, send/watch/loadManifest,
 * failure shaping) is the client's shared inspector API, re-exported here as the one-stop
 * import for the views.
 */
import type { ClientDef, Helpers, ManifestDef } from 'client:core'
import { connectClient } from 'client:core'

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
} from 'client:core'
export type Chunk = Helpers.Chunk
export type Entry = Helpers.Entry
export type Field = Helpers.Field
export type InFlight = Helpers.InFlight
export type Outcome = Helpers.Outcome
export type SendRequest = Helpers.SendRequest
export type ServiceGroup = Helpers.ServiceGroup
export type Watching = Helpers.Watching
export type WatchHandlers = Helpers.WatchHandlers
export type WireFailure = Helpers.WireFailure

export type Manifest = ManifestDef.Manifest
export type Action = ManifestDef.Action
export type Socket = ManifestDef.Socket
export type WatchFrame = ClientDef.WatchFrame<Record<string, unknown>>
export type WindowInfo = ClientDef.WindowInfo

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
