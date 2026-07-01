import type { Operation } from 'std:effect'
import { attempt, call } from 'std:effect'
import { isFailure } from 'std:result'

import { parseArgs } from 'node:util'

import type { CommandDef } from '../types/command'
import type { RawParse } from '../types/internal'

interface OptionSpec {
  type: 'string' | 'boolean'
  multiple?: boolean
  short?: string
}

const stringify = (value: string | boolean): string =>
  typeof value === 'boolean' ? String(value) : value

/**
 * Tokenize argv with Node's built-in `util.parseArgs` (no hand-rolled parser). The action's option
 * `infos` + `short` map become the parseArgs option config: boolean fields take no value, array
 * fields are `multiple`, everything else is a string the schema later coerces. Tokens after `--` are
 * kept as `rest` (parseArgs would otherwise fold them into positionals). parseArgs throws on a bad
 * parse (unknown option, missing value, value on a boolean); we run it through `attempt(call(...))`
 * so the throw is reified into a `Result` inside the effect runtime — never a bare `try/catch` — and
 * surfaced as `errors`, letting the caller render help instead of unwinding.
 */
export function* tokenize(
  args: string[],
  infos: readonly CommandDef.OptionInfo[],
  short: Record<string, string>,
): Operation<RawParse> {
  const separator = args.indexOf('--')
  const head = separator === -1 ? args : args.slice(0, separator)
  const rest = separator === -1 ? [] : args.slice(separator + 1)

  const options: Record<string, OptionSpec> = {}
  for (const info of infos) {
    const spec: OptionSpec = {
      type: info.type === 'boolean' && !info.array ? 'boolean' : 'string',
      multiple: info.array,
    }
    const flag = short[info.name]
    if (flag !== undefined) {
      spec.short = flag
    }
    options[info.name] = spec
  }

  const parsed = yield* attempt(
    call(() => parseArgs({ args: head, options, strict: true, allowPositionals: true })),
  )
  if (isFailure(parsed)) {
    // attempt() types this Failure as `Failure<never>`, but the thrown parseArgs error is the value.
    const cause: unknown = parsed.error
    const message = cause instanceof Error ? cause.message : String(cause)
    return { options: new Map(), positionals: [], rest, errors: [message] }
  }

  const parsedOptions = new Map<string, string[]>()
  for (const [name, value] of Object.entries(parsed.value.values)) {
    if (value === undefined) {
      continue
    }
    parsedOptions.set(name, Array.isArray(value) ? value.map(stringify) : [stringify(value)])
  }

  return { options: parsedOptions, positionals: [...parsed.value.positionals], rest, errors: [] }
}
