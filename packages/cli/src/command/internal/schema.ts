import type { AnyType, StandardSchemaV1 } from 'std:shared'

import { z } from 'zod'

import type { CommandDef } from '../types/command'
import type { JsonSchema } from '../types/internal'

const baseType = (type: string | string[] | undefined): 'string' | 'number' | 'boolean' => {
  const resolved = Array.isArray(type) ? type.find(entry => entry !== 'null') : type
  if (resolved === 'boolean') {
    return 'boolean'
  }
  if (resolved === 'number' || resolved === 'integer') {
    return 'number'
  }
  return 'string'
}

/**
 * Derive option metadata from an action's `input` schema by converting it to JSON Schema
 * (`z.toJSONSchema`) and walking the properties. Drives tokenizing (boolean fields take no value)
 * and help rendering; actual validation/defaults are left to the schema itself.
 */
export const optionsFromSchema = (input: StandardSchemaV1 | undefined): CommandDef.OptionInfo[] => {
  if (input === undefined) {
    return []
  }

  let json: JsonSchema
  try {
    json = z.toJSONSchema(input as AnyType, { unrepresentable: 'any', io: 'input' }) as JsonSchema
  } catch {
    return []
  }

  const required = new Set(json.required)
  const infos: CommandDef.OptionInfo[] = []

  for (const [name, prop] of Object.entries(json.properties ?? {})) {
    const array = Array.isArray(prop.type) ? prop.type.includes('array') : prop.type === 'array'
    infos.push({
      name,
      type: array ? baseType(prop.items?.type) : baseType(prop.type),
      array,
      enum: array ? prop.items?.enum : prop.enum,
      required: required.has(name),
      hasDefault: prop.default !== undefined,
    })
  }

  return infos
}
