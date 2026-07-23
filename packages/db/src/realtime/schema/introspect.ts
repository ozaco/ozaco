import type { AnyType } from 'std:shared'

import { z } from 'zod'

import { isDate, referenceOf } from './id'
import type { Column, ColumnKind } from './types'

interface JsonProp {
  type?: string | string[]
  enum?: unknown[]
  items?: { type?: string | string[]; enum?: unknown[] }
  default?: unknown
  format?: string
}

interface JsonSchema {
  properties?: Record<string, JsonProp>
  required?: string[]
}

const resolveType = (type: string | string[] | undefined): string | undefined =>
  Array.isArray(type) ? type.find(entry => entry !== 'null') : type

const kindOf = (prop: JsonProp): ColumnKind => {
  if (prop.enum && prop.enum.length > 0) {
    return 'enum'
  }
  const type = resolveType(prop.type)
  if (type === 'boolean') {
    return 'boolean'
  }
  if (type === 'integer') {
    return 'int'
  }
  if (type === 'number') {
    return 'float'
  }
  if (type === 'array' || type === 'object') {
    return 'json'
  }
  if (type === 'string' && prop.format === 'date-time') {
    return 'timestamp'
  }
  return 'text'
}

/**
 * Derive storage {@link Column}s from a zod object shape. Types/enums/defaults come from
 * `z.toJSONSchema` (the same idiom the cli + openapi plugins use); foreign keys + `z.date()` are
 * read straight off the zod instances since JSON Schema can't represent either faithfully.
 */
export const introspectColumns = (shape: z.ZodRawShape): Column[] => {
  let json: JsonSchema = {}
  try {
    json = z.toJSONSchema(z.object(shape), { unrepresentable: 'any', io: 'input' }) as AnyType
  } catch {
    json = {}
  }

  const required = new Set(json.required)
  const properties = json.properties ?? {}

  return Object.keys(shape).map(name => {
    const field = shape[name] as z.ZodType
    const prop = properties[name] ?? {}
    const nullable = Array.isArray(prop.type) && prop.type.includes('null')
    return {
      name,
      kind: isDate(field) ? 'timestamp' : kindOf(prop),
      optional: nullable || !required.has(name),
      hasDefault: prop.default !== undefined,
      enumValues: prop.enum ? prop.enum.map(String) : null,
      reference: referenceOf(field),
    }
  })
}
