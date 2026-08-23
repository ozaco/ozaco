/**
 * JSON Schema (what the manifest carries per plane) → an example value and a flat field list
 * for the Params form. Small on purpose: objects, arrays, primitives, enums, unions, defaults.
 */
export type Schema = Record<string, unknown> | null | undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const typeOf = (schema: Record<string, unknown>): string | null => {
  const type = schema['type']

  if (typeof type === 'string') {
    return type
  }

  if (Array.isArray(type)) {
    return (type.find(entry => entry !== 'null') as string | undefined) ?? null
  }

  if ('properties' in schema) {
    return 'object'
  }

  if ('items' in schema) {
    return 'array'
  }

  return null
}

/** A plausible value for a schema: defaults and enums first, then the shape. */
export const exampleOf = (schema: Schema, depth = 0): unknown => {
  if (!isRecord(schema) || depth > 6) {
    return null
  }

  if ('default' in schema) {
    return schema['default']
  }

  if ('const' in schema) {
    return schema['const']
  }

  if (Array.isArray(schema['enum']) && schema['enum'].length > 0) {
    return schema['enum'][0]
  }

  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = schema[key]

    if (Array.isArray(variants) && variants.length > 0) {
      return exampleOf(variants[0] as Schema, depth + 1)
    }
  }

  switch (typeOf(schema)) {
    case 'object': {
      const out: Record<string, unknown> = {}
      const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : [])

      for (const [name, property] of Object.entries(
        isRecord(schema['properties']) ? schema['properties'] : {},
      )) {
        if (required.has(name) || depth === 0) {
          out[name] = exampleOf(property as Schema, depth + 1)
        }
      }

      return out
    }

    case 'array': {
      return []
    }

    case 'string': {
      const format = schema['format']
      return format === 'email' ? 'user@example.com' : format === 'date-time' ? new Date().toISOString() : ''
    }
    case 'number':
    case 'integer': {
      return typeof schema['minimum'] === 'number' ? schema['minimum'] : 0
    }

    case 'boolean': {
      return false
    }

    default: {
      return null
    }
  }
}

export interface Field {
  readonly name: string
  readonly type: string
  readonly required: boolean
  readonly description: string | undefined
  readonly options: readonly unknown[] | null
}

/** The top-level fields of an object schema (what the Params form shows). */
export const fieldsOf = (schema: Schema): readonly Field[] => {
  if (!isRecord(schema) || typeOf(schema) !== 'object' || !isRecord(schema['properties'])) {
    return []
  }

  const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : [])

  return Object.entries(schema['properties']).map(([name, property]) => {
    const record = isRecord(property) ? property : {}
    return {
      name,
      type: typeOf(record) ?? (Array.isArray(record['enum']) ? 'enum' : 'any'),
      required: required.has(name),
      description: typeof record['description'] === 'string' ? record['description'] : undefined,
      options: Array.isArray(record['enum']) ? record['enum'] : null,
    }
  })
}

/** A form field's text as a value: numbers/booleans/JSON by the declared type, else the text. */
export const coerceField = (text: string, type: string): unknown => {
  if (text === '') {
    return undefined
  }

  switch (type) {
    case 'number':
    case 'integer': {
      const number = Number(text)
      return Number.isNaN(number) ? text : number
    }

    case 'boolean': {
      return text === 'true'
    }
    case 'object':
    case 'array': {
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }

    default: {
      return text
    }
  }
}
