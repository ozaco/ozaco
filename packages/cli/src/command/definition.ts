// oxlint-disable import/exports-last
import type { StandardSchemaV1 } from 'cli:core'
import type { Operation } from 'std:effect'
import type { AnyType, EmptyType } from 'std:shared'

import { ACTION, COMMAND } from './const'
import { get, register, run } from './internal/registry-actions'
import { Registry } from './registry'
import type { CommandDef } from './types/command'
import type { RegistryDef } from './types/registry'

/**
 * The default registry impl: an in-memory command map. `register` compiles a spec into its runtime
 * node (its `setup` stays un-run — see internal/registry-actions for the rationale) and `run`
 * dispatches argv against it.
 */
export const DefaultRegistry = Registry.implement<
  RegistryDef.Context,
  [options?: RegistryDef.Options]
>({
  name: 'cli-default-registry',
  version: '0.1.0',
  description: 'In-memory command registry',
  *setup(options: RegistryDef.Options = {}) {
    return {
      name: options.name ?? 'cli',
      version: options.version,
      description: options.description,
      commands: new Map<string, RegistryDef.Command>(),
    }
  },
}).build({ register, run, get })

/**
 * Define a leaf subcommand (mirrors server's `defineAction`). The `input` schema types the
 * handler's `ctx` (`StandardSchemaV1.InferOutput`); `short` maps fields to short flags; `args`
 * lists fields fillable positionally; `options` declares flags manually (required for non-zod
 * schemas — see internal/schema). Pure metadata-carrying handler — the runner parses+validates
 * before calling.
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
    options: config.options,
    short: config.short,
    args: config.args,
  })
}

/**
 * Define a command. Returns a pure spec (no plugin is built here) — the registry compiles it into a
 * path-identified plugin tree at `register`, and installs each level lazily as dispatch descends
 * into it. `actions` mixes leaf actions (`defineAction`, split into `leaf`) and nested commands
 * (`subs`).
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
