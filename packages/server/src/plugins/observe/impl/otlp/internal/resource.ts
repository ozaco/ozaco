// oxlint-disable import/exports-last
import type { TraceDef } from 'std:trace'

import type { Helpers } from '../types/helpers'
import type { OtlpDef } from '../types/otlp'

/** The identity of a resource block: (service.name, service.instance.id). */
const resourceKey = (resource: OtlpDef.ResourceAttributes): string =>
  `${String(resource['service.name'] ?? '')}\u0000${String(resource['service.instance.id'] ?? '')}`

const scopeKey = (scope: TraceDef.InstrumentationScope): string =>
  `${scope.name}\u0000${scope.version ?? ''}`

/**
 * Group records into OTLP resource blocks — one per (service.name, service.instance.id), its
 * attributes = `base` (`EncodeOptions.resource`) under the event's own — and,
 * inside each, one scope block per instrumentation scope. Order of first appearance is kept.
 */
export const groupByResource = <T>(
  entries: readonly Helpers.Entry<T>[],
  base: OtlpDef.ResourceAttributes,
): Helpers.ResourceGroup<T>[] => {
  const groups = new Map<string, { group: Helpers.ResourceGroup<T>; scopes: Map<string, T[]> }>()
  const empty = Object.keys(base).length === 0

  for (const entry of entries) {
    const key = resourceKey(entry.resource)
    let found = groups.get(key)

    if (!found) {
      found = {
        group: { resource: empty ? entry.resource : { ...base, ...entry.resource }, scopes: [] },
        scopes: new Map(),
      }
      groups.set(key, found)
    }

    const at = scopeKey(entry.scope)
    let items = found.scopes.get(at)

    if (!items) {
      items = []
      found.scopes.set(at, items)
      found.group.scopes.push({ scope: entry.scope, items })
    }

    items.push(entry.item)
  }

  return [...groups.values()].map(found => found.group)
}
