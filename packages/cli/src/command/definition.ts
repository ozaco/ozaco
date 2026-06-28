import { Registry } from 'cli:core'
import type { RegistryDef } from 'cli:core'
import type { Operation } from 'std:effect'
import { definePlugin, install } from 'std:plugin'
import type { AnyType, EmptyType, StandardSchemaV1 } from 'std:shared'

import { ACTION, COMMAND } from './const'
import { get, register, run } from './internal/registry-actions'
import { setSubcommands } from './internal/subcommands'
import type { CommandDef } from './types/command'

/**
 * Define a leaf subcommand (mirrors server's `defineAction`). The `input` schema types the handler's
 * `ctx` (`StandardSchemaV1.InferOutput`); `short` maps fields to short flags; `args` lists fields
 * fillable positionally. Pure metadata-carrying handler — the runner parses+validates before calling.
 */
export function defineAction<S extends StandardSchemaV1, R, E = never>(
  config: CommandDef.ActionConfig<S> & { input: S },
  handler: (ctx: StandardSchemaV1.InferOutput<S>) => Operation<R, E>,
): CommandDef.Action<S, R, E>
export function defineAction<R, E = never>(
  config: Omit<CommandDef.ActionConfig, 'input'>,
  handler: (ctx: EmptyType) => Operation<R, E>,
): CommandDef.Action<unknown, R, E>
export function defineAction(config: AnyType, handler: AnyType): AnyType {
  return Object.assign(handler, {
    _t: ACTION,
    input: config.input,
    description: config.description,
    short: config.short,
    args: config.args,
  })
}

/**
 * Define a command. Like `defineService`, it is a `definePlugin(subtype: COMMAND).build(actions)`
 * plugin you `install()`. `actions` mixes leaf actions (`defineAction`) and nested commands; nested
 * commands are split off into `subcommands` and auto-installed by this command's `setup`.
 */
export const defineCommand = <TContext = unknown, TError = unknown, TArgs extends unknown[] = []>(
  options: CommandDef.Options<TContext, TError, TArgs>,
): CommandDef.Command<TContext, TError, TArgs> => {
  const subcommands: Record<string, CommandDef.Command<AnyType, AnyType, AnyType>> = {}
  const leaf: Record<string, CommandDef.Member> = {}

  for (const [key, member] of Object.entries(options.actions)) {
    if ((member as { _st?: symbol })._st === COMMAND) {
      subcommands[key] = member as CommandDef.Command<AnyType, AnyType, AnyType>
    } else {
      leaf[key] = member
    }
  }

  const command = definePlugin({
    subtype: COMMAND,
    name: options.name,
    description: options.description,
    version: options.version ?? '0.0.0',
    setup: function* (...args: AnyType[]) {
      const context = options.setup ? yield* options.setup(...(args as TArgs)) : undefined
      for (const sub of Object.values(subcommands)) {
        yield* install(sub as AnyType)
      }
      return context
    } as AnyType,
  }).build(leaf as AnyType) as AnyType

  setSubcommands(command, subcommands)

  return command as CommandDef.Command<TContext, TError, TArgs>
}

/**
 * The command registry (mirrors the backend `Broker`). Install it, `register` your commands (each is
 * installed automatically), then `run(argv)` dispatches `argv[0]` to the matching command.
 */
export const DefaultRegistry = Registry.implement({
  name: 'cli/default-registry',
  version: '0.0.0',
  *setup(options: RegistryDef.Options = {}) {
    return {
      name: options.name ?? 'cli',
      version: options.version,
      description: options.description,
      commands: new Map<string, RegistryDef.Command>(),
    }
  },
}).build({ register, run, get })

export { CommandErrors } from './const'
export type { CommandDef } from './types/command'
