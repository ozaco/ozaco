import type { RegistryDef } from 'cli:core'
import { Registry } from 'cli:core'
import type { Operation } from 'std:effect'
import type { AnyType, EmptyType, StandardSchemaV1 } from 'std:shared'

import { ACTION, COMMAND } from './const'
import { get, register, run } from './internal/registry-actions'
import type { CommandDef } from './types/command'

/**
 * Define a leaf subcommand (mirrors server's `defineAction`). The `input` schema types the handler's
 * `ctx` (`StandardSchemaV1.InferOutput`); `short` maps fields to short flags; `args` lists fields
 * fillable positionally. Pure metadata-carrying handler — the runner parses+validates before calling.
 */
export function defineAction<S extends StandardSchemaV1, R>(
  config: CommandDef.ActionConfig<S> & { input: S },
  handler: (ctx: StandardSchemaV1.InferOutput<S>) => Operation<R>,
): CommandDef.Action<S, R>
export function defineAction<R>(
  config: Omit<CommandDef.ActionConfig, 'input'>,
  handler: (ctx: EmptyType) => Operation<R>,
): CommandDef.Action<unknown, R>
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
 * Define a command. Returns a pure spec (no plugin is built here) — the registry compiles it into a
 * path-identified plugin tree at `register`, and installs each level lazily as dispatch descends into
 * it. `actions` mixes leaf actions (`defineAction`, split into `leaf`) and nested commands (`subs`).
 */
export const defineCommand = <TContext = unknown, TArgs extends unknown[] = []>(
  options: CommandDef.Options<TContext, TArgs>,
): CommandDef.Spec<TContext, TArgs> => {
  const leaf: Record<string, CommandDef.Action<AnyType, AnyType>> = {}
  const subs: Record<string, CommandDef.Spec> = {}

  for (const [key, member] of Object.entries(options.actions)) {
    if ((member as { _st?: symbol })._st === COMMAND) {
      subs[key] = member as CommandDef.Spec
    } else {
      leaf[key] = member as CommandDef.Action<AnyType, AnyType>
    }
  }

  return {
    _st: COMMAND,
    name: options.name,
    version: options.version,
    description: options.description,
    leaf,
    subs,
    setup: options.setup,
  } as CommandDef.Spec<TContext, TArgs>
}

/**
 * The command registry (mirrors the backend `Broker`). Install it, `register` your commands (each is
 * compiled + its own setup run), then `run(argv)` dispatches `argv[0]` to the matching command tree.
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
