import type { CommandDef } from '../types/command'
import type { Helpers } from '../types/helpers'

// Bad numbers are left as their original string so the schema reports a clear validation error.
const convert = (type: 'string' | 'number' | 'boolean', value: string): unknown => {
  if (type === 'number') {
    const parsed = Number(value)
    return Number.isNaN(parsed) ? value : parsed
  }
  if (type === 'boolean') {
    return value !== 'false'
  }
  return value
}

/**
 * Assemble the raw input object from tokenized argv: positionals map onto `args` fields, options map
 * by name, strings are converted to their schema type. Missing fields are omitted so the schema
 * applies its own defaults / required checks.
 */
export const build = (
  infos: readonly CommandDef.OptionInfo[],
  raw: Helpers.RawParse,
  args: readonly string[],
): Record<string, unknown> => {
  const byName = new Map(infos.map(info => [info.name, info]))
  const values: Record<string, unknown> = {}

  for (const [index, field] of args.entries()) {
    const value = raw.positionals[index]
    if (value === undefined) {
      continue
    }
    const info = byName.get(field)
    const converted = convert(info?.type ?? 'string', value)
    values[field] = info?.array ? [converted] : converted
  }

  for (const info of infos) {
    const got = raw.options.get(info.name)
    if (got === undefined || got.length === 0) {
      continue
    }
    values[info.name] = info.array
      ? got.map(value => convert(info.type, value))
      : convert(info.type, got[got.length - 1]!)
  }

  return values
}
