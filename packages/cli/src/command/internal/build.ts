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
 *
 * A trailing `args` field with an array type is variadic — it collects EVERY remaining positional.
 * Positionals left over with no field to absorb them are reported as parse errors (never silently
 * dropped).
 */
export const build = (
  infos: readonly CommandDef.OptionInfo[],
  raw: Helpers.RawParse,
  args: readonly string[],
): { values: Record<string, unknown>; errors: string[] } => {
  const byName = new Map(infos.map(info => [info.name, info]))
  const values: Record<string, unknown> = {}
  const errors: string[] = []
  let consumed = 0

  for (const [index, field] of args.entries()) {
    if (index >= raw.positionals.length) {
      break
    }
    const info = byName.get(field)
    const type = info?.type ?? 'string'

    if (info?.array && index === args.length - 1) {
      values[field] = raw.positionals.slice(index).map(value => convert(type, value))
      consumed = raw.positionals.length
      break
    }

    const converted = convert(type, raw.positionals[index]!)
    values[field] = info?.array ? [converted] : converted
    consumed = index + 1
  }

  const surplus = raw.positionals.slice(consumed)
  if (surplus.length > 0) {
    errors.push(
      surplus.length === 1
        ? `Unexpected argument '${surplus[0]}'`
        : `Unexpected arguments ${surplus.map(value => `'${value}'`).join(', ')}`,
    )
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

  return { values, errors }
}
