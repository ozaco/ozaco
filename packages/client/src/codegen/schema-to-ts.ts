/**
 * JSON Schema document → TypeScript type TEXT. Deliberately small and dependency-free: it covers
 * what `z.toJSONSchema` emits for wizard schemas (objects, arrays, primitives, enum/const
 * literals, anyOf/oneOf unions, additionalProperties) — anything unrecognized (including the
 * manifest's `{ declared: true }` opaque marker) degrades to `unknown`, never to an error.
 */

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u

const INDENT = '  '

const isRecord = (value: unknown): value is Record<string, unknown> =>
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

/** Wrap union/intersection texts before suffixing `[]`. */
const wrapForArray = (text: string): string =>
  text.includes('|') || text.includes('&') ? `(${text})` : text

const unionOf = (variants: readonly unknown[], depth: number): string => {
  const parts = variants.map(variant => schemaToType(variant, depth))
  const unique = [...new Set(parts)]

  return unique.join(' | ')
}

const objectOf = (schema: Record<string, unknown>, depth: number): string => {
  const properties = isRecord(schema['properties']) ? schema['properties'] : undefined
  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter(key => typeof key === 'string')
      : [],
  )
  const additional = schema['additionalProperties']

  const lines: string[] = []
  const inner = INDENT.repeat(depth + 1)

  for (const [key, value] of Object.entries(properties ?? {})) {
    const optional = required.has(key) ? '' : '?'

    lines.push(`${inner}${propertyKey(key)}${optional}: ${schemaToType(value, depth + 1)}`)
  }

  if (isRecord(additional)) {
    lines.push(`${inner}[key: string]: ${schemaToType(additional, depth + 1)}`)
  }

  if (lines.length === 0) {
    if (additional === false) {
      return 'Record<string, never>'
    }

    return 'Record<string, unknown>'
  }

  return `{\n${lines.join('\n')}\n${INDENT.repeat(depth)}}`
}

const primitiveOf = (type: string, schema: Record<string, unknown>, depth: number): string => {
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
      return objectOf(schema, depth)
    }
    case 'array': {
      const items = schema['items']

      return items === undefined ? 'unknown[]' : `${wrapForArray(schemaToType(items, depth))}[]`
    }
    default: {
      return 'unknown'
    }
  }
}

/** Render one JSON Schema document as TypeScript type text (multi-line for object shapes). */
export const schemaToType = (schema: unknown, depth = 0): string => {
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
    )
  }

  if (Array.isArray(schema['anyOf'])) {
    return unionOf(schema['anyOf'], depth)
  }

  if (Array.isArray(schema['oneOf'])) {
    return unionOf(schema['oneOf'], depth)
  }

  if (Array.isArray(schema['allOf'])) {
    const parts = schema['allOf'].map(variant => schemaToType(variant, depth))

    return parts.join(' & ')
  }

  const type = schema['type']

  if (Array.isArray(type)) {
    return unionOf(
      type.map(one => ({ ...schema, type: one })),
      depth,
    )
  }

  if (typeof type === 'string') {
    return primitiveOf(type, schema, depth)
  }

  if (isRecord(schema['properties'])) {
    return objectOf(schema, depth)
  }

  return 'unknown'
}
