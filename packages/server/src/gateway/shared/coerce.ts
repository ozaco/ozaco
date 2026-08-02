import { bodyChannel } from 'server:core'
import type { GatewayDef } from 'server:core'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

/** The primitive targets one key's query/path string may be coerced into. A key whose schema also
 * accepts strings never appears in a table — the raw string was already valid, and rewriting it
 * would second-guess the validator. */
interface Coercible {
  readonly number: boolean
  readonly boolean: boolean
}

type Table = ReadonlyMap<string, Coercible>

const NUMERIC = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u

interface Kinds {
  readonly number: boolean
  readonly boolean: boolean
  readonly string: boolean
}

const NONE: Kinds = { number: false, boolean: false, string: false }
/** "Leave it alone": counts as string-accepting so the key never enters the table. */
const OPAQUE: Kinds = { number: false, boolean: false, string: true }

const merge = (into: Kinds, from: Kinds): Kinds => ({
  number: into.number || from.number,
  boolean: into.boolean || from.boolean,
  string: into.string || from.string,
})

const kindsOf = (schema: AnyType): Kinds => {
  if (!schema || typeof schema !== 'object') {
    return OPAQUE
  }
  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined
  if (variants) {
    return variants.map(kindsOf).reduce(merge, NONE)
  }
  if (Array.isArray(schema.enum)) {
    return {
      number: schema.enum.some((value: unknown) => typeof value === 'number'),
      boolean: schema.enum.some((value: unknown) => typeof value === 'boolean'),
      string: schema.enum.some((value: unknown) => typeof value === 'string'),
    }
  }
  if ('const' in schema) {
    return {
      number: typeof schema.const === 'number',
      boolean: typeof schema.const === 'boolean',
      string: typeof schema.const === 'string',
    }
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return { number: true, boolean: false, string: false }
  }
  if (schema.type === 'boolean') {
    return { number: false, boolean: true, string: false }
  }
  // `null` is the nullable() member: it neither blocks a sibling's coercion nor coerces itself
  if (schema.type === 'null') {
    return NONE
  }
  // strings, objects, arrays, untyped: the raw string goes to the validator untouched
  return OPAQUE
}

const tables = new WeakMap<GatewayDef.RegisteredRoute, Table | null>()

export type CoercionTable = Table

/**
 * The per-route answer to "which params are safe to coerce, and into what" — derived from the
 * action's own input schema, so a GET route whose args say `z.number()` accepts `?limit=50` without
 * every author remembering `z.coerce`. Computed once per route and cached: the schema is fixed at
 * definition time. A non-zod (or unrepresentable) input yields no table and params stay strings,
 * exactly the previous behavior.
 */
export const paramCoercions = (entry: GatewayDef.RegisteredRoute): CoercionTable | null => {
  const cached = tables.get(entry)
  if (cached !== undefined) {
    return cached
  }

  let table: CoercionTable | null = null
  const schema = bodyChannel((entry.action as AnyType)?.wire?.input ?? [])?.schema
  if (schema) {
    try {
      const json = z.toJSONSchema(schema as AnyType, { unrepresentable: 'any', io: 'input' })
      const properties = (json as AnyType)?.properties
      if (properties && typeof properties === 'object') {
        const map = new Map<string, Coercible>()
        for (const [key, property] of Object.entries(properties)) {
          const kind = kindsOf(property)
          if (!kind.string && (kind.number || kind.boolean)) {
            map.set(key, { number: kind.number, boolean: kind.boolean })
          }
        }
        table = map.size > 0 ? map : null
      }
    } catch {
      // not zod-representable — no coercion for this route
    }
  }
  tables.set(entry, table)
  return table
}

/** Coerce query/path params (always strings on the wire) into the primitives the arg schema expects.
 * A value that does not parse cleanly stays a string so the validator reports it, same as before. */
export const coerceParams = (
  params: Record<string, unknown>,
  table: CoercionTable | null,
): Record<string, unknown> => {
  if (!table) {
    return params
  }
  let changed = false
  const out: Record<string, unknown> = { ...params }
  for (const [key, kind] of table) {
    const value = out[key]
    if (typeof value !== 'string') {
      continue
    }
    if (kind.boolean && (value === 'true' || value === 'false')) {
      out[key] = value === 'true'
      changed = true
    } else if (kind.number && NUMERIC.test(value)) {
      out[key] = Number(value)
      changed = true
    }
  }
  return changed ? out : params
}
