// oxlint-disable import/exports-last
import type { SchemaStyle } from '../types'

import { IDENTIFIER, INDENT } from './const'

const PLAIN: SchemaStyle = {}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Single-quoted TS string literal (the repo's quote style). */
const quoted = (text: string): string =>
  `'${text.replaceAll('\\', String.raw`\\`).replaceAll("'", String.raw`\'`)}'`

const literalOf = (value: unknown): string => {
  if (typeof value === 'string') {
    return quoted(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (value === null) {
    return 'null'
  }

  return 'unknown'
}

const propertyKey = (key: string): string => (IDENTIFIER.test(key) ? key : quoted(key))

/** Wrap union/intersection/readonly texts before suffixing `[]`. */
const wrapForArray = (text: string): string =>
  text.includes('|') || text.includes('&') || text.startsWith('readonly ') ? `(${text})` : text

/** A schema's `description`, as the JSDoc line `docs` emits (a comment terminator inside it is defused). */
const docLine = (schema: unknown, indent: string, style: SchemaStyle): string[] => {
  const description = isRecord(schema) ? schema['description'] : undefined

  return style.docs && typeof description === 'string' && description !== ''
    ? [`${indent}/** ${description.replaceAll('*/', '* /')} */`]
    : []
}

const unionOf = (variants: readonly unknown[], depth: number, style: SchemaStyle): string => {
  const parts = variants.map(variant => typeTextOf(variant, depth, style))
  const unique = [...new Set(parts)]

  return unique.join(' | ')
}

const objectOf = (schema: Record<string, unknown>, depth: number, style: SchemaStyle): string => {
  const properties = isRecord(schema['properties']) ? schema['properties'] : undefined

  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter(key => typeof key === 'string')
      : [],
  )
  const additional = schema['additionalProperties']
  const modifier = style.readonly ? 'readonly ' : ''

  const lines: string[] = []
  const inner = INDENT.repeat(depth + 1)

  for (const [key, value] of Object.entries(properties ?? {})) {
    const optional = required.has(key) ? '' : '?'
    const widened = optional && style.exactOptional ? ' | undefined' : ''

    lines.push(
      ...docLine(value, inner, style),
      `${inner}${modifier}${propertyKey(key)}${optional}: ${typeTextOf(value, depth + 1, style)}${widened}`,
    )
  }

  if (isRecord(additional)) {
    lines.push(`${inner}${modifier}[key: string]: ${typeTextOf(additional, depth + 1, style)}`)
  }

  if (lines.length === 0) {
    if (additional === false) {
      return 'Record<string, never>'
    }

    return 'Record<string, unknown>'
  }

  return `{\n${lines.join('\n')}\n${INDENT.repeat(depth)}}`
}

const primitiveOf = (
  type: string,
  schema: Record<string, unknown>,
  walk: { readonly depth: number; readonly style: SchemaStyle },
): string => {
  switch (type) {
    case 'string': {
      return 'string'
    }
    case 'number':
    case 'integer': {
      return 'number'
    }

    case 'boolean': {
      return 'boolean'
    }

    case 'null': {
      return 'null'
    }

    case 'object': {
      return objectOf(schema, walk.depth, walk.style)
    }

    case 'array': {
      const items = schema['items']
      const text =
        items === undefined
          ? 'unknown[]'
          : `${wrapForArray(typeTextOf(items, walk.depth, walk.style))}[]`

      return walk.style.readonly ? `readonly ${text}` : text
    }

    default: {
      return 'unknown'
    }
  }
}

/** The type text of one schema node at `depth` (object shapes indent by it); `style` adds
 * `readonly` members / arrays and JSDoc lines from `description`. */
export const typeTextOf = (schema: unknown, depth: number, style: SchemaStyle = PLAIN): string => {
  if (!isRecord(schema)) {
    return 'unknown'
  }

  if (schema['declared'] === true) {
    return 'unknown'
  }

  if ('const' in schema) {
    return literalOf(schema['const'])
  }

  if (Array.isArray(schema['enum'])) {
    return unionOf(
      schema['enum'].map(value => ({ const: value })),
      depth,
      style,
    )
  }

  if (Array.isArray(schema['anyOf'])) {
    return unionOf(schema['anyOf'], depth, style)
  }

  if (Array.isArray(schema['oneOf'])) {
    return unionOf(schema['oneOf'], depth, style)
  }

  if (Array.isArray(schema['allOf'])) {
    const parts = schema['allOf'].map(variant => typeTextOf(variant, depth, style))

    return parts.join(' & ')
  }

  const type = schema['type']

  if (Array.isArray(type)) {
    return unionOf(
      type.map(one => ({ ...schema, type: one })),
      depth,
      style,
    )
  }

  if (typeof type === 'string') {
    return primitiveOf(type, schema, { depth, style })
  }

  if (isRecord(schema['properties'])) {
    return objectOf(schema, depth, style)
  }

  return 'unknown'
}

/**
 * Every string enum a schema declares at a property, keyed by the property's name, walking
 * objects, arrays, unions and intersections. A key met twice with the SAME values is one
 * entry; different values under one key are kept apart by `pick`.
 */
export const enumsOf = (
  schema: unknown,
  into: Map<string, readonly string[]>,
  pick: (key: string) => string,
): void => {
  if (!isRecord(schema)) {
    return
  }

  const properties = isRecord(schema['properties']) ? schema['properties'] : {}

  for (const [key, value] of Object.entries(properties)) {
    const values = isRecord(value) && Array.isArray(value['enum']) ? value['enum'] : null

    if (values && values.every(item => typeof item === 'string')) {
      const known = into.get(key)

      if (known === undefined) {
        into.set(key, values)
      } else if (known.join('\u0000') !== values.join('\u0000')) {
        into.set(pick(key), values)
      }
    }

    enumsOf(value, into, pick)
  }

  for (const branch of ['items', 'additionalProperties']) {
    enumsOf(schema[branch], into, pick)
  }

  for (const branch of ['anyOf', 'oneOf', 'allOf']) {
    const variants = schema[branch]

    if (Array.isArray(variants)) {
      for (const variant of variants) {
        enumsOf(variant, into, pick)
      }
    }
  }
}
