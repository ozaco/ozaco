import type { Operation } from 'std:effect'
import { attempt, call } from 'std:effect'
import { isFailure } from 'std:result'
import { serializeError } from 'std:shared'

import { parseArgs } from 'node:util'

import type { CommandDef } from '../types/command'
import type { Helpers } from '../types/helpers'

const stringify = (value: string | boolean): string =>
  typeof value === 'boolean' ? String(value) : value

/**
 * Tokenize argv with `util.parseArgs` (no hand-rolled parser; Bun ships the module natively). The
 * action's option `infos` + `short` map become the parseArgs option config: boolean fields take no
 * value, array fields are `multiple`, everything else is a string the schema later coerces. Tokens
 * after `--` are kept as `rest` (parseArgs would otherwise fold them into positionals). parseArgs
 * throws on a bad parse (unknown option, missing value, value on a boolean); we run it through
 * `attempt(call(...))` so the throw is reified into a `Result` inside the effect runtime — never a
 * bare `try/catch` — and surfaced as `errors`, letting the caller render help instead of unwinding.
 */
export function* tokenize(
  args: string[],
  infos: readonly CommandDef.OptionInfo[],
  short: Record<string, string>,
): Operation<Helpers.RawParse> {
  const separator = args.indexOf('--')
  const head = separator === -1 ? args : args.slice(0, separator)
  const rest = separator === -1 ? [] : args.slice(separator + 1)

  const options: Record<string, Helpers.OptionSpec> = {}
  for (const info of infos) {
    const spec: Helpers.OptionSpec = {
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
    const message = serializeError(parsed)
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
