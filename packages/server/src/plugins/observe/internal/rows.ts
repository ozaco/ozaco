import type { ObserveDef } from 'server:core'
import type { TraceDef } from 'std:trace'

import type { Helpers } from '../types/helpers'

/** The two resource keys the rows keep as columns. */
export const COLUMNS = new Set(['service.name', 'service.instance.id'])

/** The resource minus its two column keys — per resource OBJECT (the kernel shares one frozen
 * object per service name, so this runs once per name). */
export const restCache = new WeakMap<ObserveDef.Resource, Helpers.ResourceAttributes>()

export const restOf = (resource: ObserveDef.Resource): Helpers.ResourceAttributes => {
  const cached = restCache.get(resource)

  if (cached) {
    return cached
  }

  const rest = Object.fromEntries(Object.entries(resource).filter(([key]) => !COLUMNS.has(key)))
  restCache.set(resource, rest)

  return rest
}

export const text = (value: TraceDef.AttrValue | undefined): string | null =>
  typeof value === 'string' && value.length > 0
    ? value
    : typeof value === 'number'
      ? String(value)
      : null

export const int = (value: TraceDef.AttrValue | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null

export const resourceOfRow = (
  row: ObserveDef.SpanRow | ObserveDef.LogRow,
): ObserveDef.Resource => ({
  ...row.resource,
  'service.name': row.service_name,
  'service.instance.id': row.service_instance_id,
})

export const scopeOfRow = (
  row: ObserveDef.SpanRow | ObserveDef.LogRow,
): TraceDef.InstrumentationScope =>
  row.scope_version === null ? { name: row.scope } : { name: row.scope, version: row.scope_version }
