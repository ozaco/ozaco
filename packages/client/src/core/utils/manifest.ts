// oxlint-disable import/exports-last
/**
 * Manifest navigation: the manifest indexed the way a browsing tool walks it — services as
 * groups of openable entries (actions + their sockets), free sockets, lookup by id, `:param`
 * names, text filtering. Pure data helpers over `ManifestDef`.
 */
import type { ManifestDef } from '../types/manifest'

/** One openable thing in the sidebar. */
export type Entry =
  | { readonly kind: 'action'; readonly id: string; readonly action: ManifestDef.Action }
  | { readonly kind: 'socket'; readonly id: string; readonly socket: ManifestDef.Socket }

export interface ServiceGroup {
  readonly name: string
  readonly version: string
  readonly description: string | undefined
  readonly entries: readonly Entry[]
}

export const groupsOf = (manifest: ManifestDef.Manifest): readonly ServiceGroup[] =>
  manifest.services.map(service => ({
    name: service.name,
    version: service.version,
    description: service.description,
    entries: [
      ...service.actions.map(action => ({ kind: 'action' as const, id: action.id, action })),
      ...(service.sockets ?? []).map(socket => ({
        kind: 'socket' as const,
        id: `ws:${socket.path}`,
        socket,
      })),
    ],
  }))

/** Socket routes that belong to no service (custom sockets mounted by the app). */
export const orphanSockets = (manifest: ManifestDef.Manifest): readonly ManifestDef.Socket[] =>
  (manifest.sockets ?? []).filter(socket => socket.service === null)

export const findEntry = (manifest: ManifestDef.Manifest, id: string): Entry | null => {
  for (const group of groupsOf(manifest)) {
    const entry = group.entries.find(candidate => candidate.id === id)

    if (entry) {
      return entry
    }
  }

  const socket = orphanSockets(manifest).find(candidate => `ws:${candidate.path}` === id)

  return socket ? { kind: 'socket', id, socket } : null
}

/** `:id` names in a route path. */
export const pathParams = (path: string): readonly string[] =>
  [...path.matchAll(/:([A-Za-z_]\w*)/gu)].map(match => match[1]!)

export const matches = (entry: Entry, query: string): boolean => {
  const needle = query.trim().toLowerCase()

  if (needle.length === 0) {
    return true
  }

  if (entry.kind === 'socket') {
    return entry.socket.path.toLowerCase().includes(needle)
  }

  const { action } = entry

  return (
    action.id.toLowerCase().includes(needle) ||
    action.route.path.toLowerCase().includes(needle) ||
    action.route.method.toLowerCase() === needle ||
    action.tags.some(tag => tag.toLowerCase().includes(needle))
  )
}
