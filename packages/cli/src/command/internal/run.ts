import { Palette, Terminal } from 'cli:core'
import type { Operation } from 'std:effect'
import { until, useContext } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType, StandardSchemaV1 } from 'std:shared'
import { isPromise } from 'std:shared'

import { CommandErrors, HELP_FLAGS, VERSION_FLAGS } from '../const'
import type { CommandDef } from '../types/command'
import type { ActionHelp } from '../types/internal'

import { build } from './build'
import { renderActionHelp, renderCommandHelp } from './help'
import { optionsFromSchema } from './schema'
import { getSubcommands } from './subcommands'
import { tokenize } from './tokenize'

const hasFlag = (argv: string[], flags: string[]): boolean =>
  argv.some(token => flags.includes(token))

const validate = function* (input: StandardSchemaV1, value: unknown) {
  const result = input['~standard'].validate(value)
  return (
    isPromise(result) ? yield* until(result) : result
  ) as StandardSchemaV1.ValidationResult<unknown>
}

const formatIssues = (issues: readonly StandardSchemaV1.Issue[]): string =>
  issues
    .map(issue => {
      const path = (issue.path ?? [])
        .map(seg =>
          typeof seg === 'object' ? String((seg as { key: PropertyKey }).key) : String(seg),
        )
        .join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    .join('\n')

/**
 * Parse argv against a command plugin and dispatch the matched action (the CLI analog of
 * `Broker.call`). Walks `subcommands` for the deepest match, handles `--help`/`--version`, builds the
 * action's input from argv, validates it with the action's schema, and invokes the action through the
 * plugin's `actions` proxy. On a parse/validation error it writes the message + help and fails with
 * `CommandErrors.Parse`. Requires Terminal + Palette installed (and the command installed).
 */
export function* runCommand(
  root: CommandDef.Command<AnyType, AnyType, AnyType>,
  argv?: string[],
): Operation<void, unknown> {
  const fromProcess = typeof process === 'undefined' ? [] : process.argv.slice(2)
  const args = (argv ?? fromProcess).slice()
  const palette = yield* useContext(Palette)

  let command = root
  const path = [root.name]
  let rest = args
  for (;;) {
    const token = rest[0]
    if (token === undefined || token.startsWith('-')) {
      break
    }
    const sub = getSubcommands(command)[token]
    if (sub === undefined) {
      break
    }
    command = sub
    path.push(token)
    rest = rest.slice(1)
  }

  const keys = command.getKeys()
  const head = rest[0]
  let actionKey: string | undefined
  let actionArgv = rest
  if (head !== undefined && !head.startsWith('-') && keys.includes(head)) {
    actionKey = head
    actionArgv = rest.slice(1)
    path.push(head)
  } else if (keys.includes('default')) {
    actionKey = 'default'
  }

  if (command.version !== undefined && hasFlag(rest, VERSION_FLAGS)) {
    yield* Terminal.actions.write(`${command.version}\n`)
    return
  }

  if (actionKey === undefined) {
    yield* Terminal.actions.write(`${renderCommandHelp(command, path, palette)}\n`)
    return
  }

  const meta = (command.getMeta(actionKey) ?? {}) as CommandDef.ActionMeta
  const infos = optionsFromSchema(meta.input)
  const short = meta.short ?? {}
  const argsOrder = meta.args ?? []
  const actionHelp: ActionHelp = {
    path,
    description: meta.description,
    infos,
    short,
    args: argsOrder,
  }

  if (hasFlag(actionArgv, HELP_FLAGS)) {
    yield* Terminal.actions.write(`${renderActionHelp(actionHelp, palette)}\n`)
    return
  }

  const booleanFields = new Set(
    infos.filter(info => info.type === 'boolean' && !info.array).map(info => info.name),
  )
  const aliases = new Map<string, string>()
  for (const info of infos) {
    aliases.set(info.name, info.name)
  }
  for (const [field, flag] of Object.entries(short)) {
    aliases.set(flag, field)
  }

  const raw = tokenize(actionArgv, booleanFields, aliases)
  const built = build(infos, raw, argsOrder)
  const errors = [...raw.errors]
  let ctx: unknown = built

  if (meta.input !== undefined) {
    const result = yield* validate(meta.input, built)
    if (result.issues) {
      errors.push(formatIssues(result.issues))
    } else {
      ctx = result.value
    }
  }

  if (errors.length > 0) {
    const text = errors.join('\n')
    const help = renderActionHelp(actionHelp, palette)
    yield* Terminal.actions.write(`${palette.colors.error(text)}\n\n${help}\n`)
    return yield* fail(CommandErrors.Parse, text)
  }

  yield* command.actions[actionKey](ctx)
}
