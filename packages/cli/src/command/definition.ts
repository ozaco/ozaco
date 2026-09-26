import type { StandardSchemaV1 } from 'cli:core'
import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import pkg from '../../package.json'

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
  version: pkg.version,
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
 * handler's `ctx` (`StandardSchemaV1.InferOutput`, plus the runtime `'--'`/`cwd` fields); `short`
 * maps fields to short flags; `args` lists fields fillable positionally (a trailing array field is
 * variadic); `options` declares flags manually (required for non-zod schemas — see
 * internal/schema); `examples` feed help. `inherits` (a command spec or its inherited `input`
 * schema) types the options a command passes down into `ctx` too — the action's own field of the
 * same name wins — and is type-only. Pure metadata-carrying handler — the runner parses+validates
 * before calling.
 */
export function defineAction<
  S extends StandardSchemaV1,
  R,
  P extends CommandDef.Inherits | undefined = undefined,
>(
  config: CommandDef.ActionConfig<S, P> & { input: S },
  handler: (ctx: CommandDef.Ctx<S, CommandDef.InheritedOf<P>>) => Operation<R>,
): CommandDef.Action<S, R, CommandDef.InheritedOf<P>>
export function defineAction<R, P extends CommandDef.Inherits | undefined = undefined>(
  config: Omit<CommandDef.ActionConfig<StandardSchemaV1, P>, 'input'>,
  handler: (ctx: CommandDef.Ctx<unknown, CommandDef.InheritedOf<P>>) => Operation<R>,
): CommandDef.Action<unknown, R, CommandDef.InheritedOf<P>>
export function defineAction(config: AnyType, handler: AnyType): AnyType {
  return Object.assign(handler, {
    _t: ACTION,
    input: config.input,
    description: config.description,
    options: config.options,
    short: config.short,
    args: config.args,
    examples: config.examples,
  })
}

/**
 * Define a command. Returns a pure spec (no plugin is built here) — the registry compiles it into a
 * path-identified plugin tree at `register`, and installs each level lazily as dispatch descends
 * into it. `actions` mixes leaf actions (`defineAction`, split into `leaf`) and nested commands
 * (`subs`). `input`/`options`/`short` declare options inherited by every action below this command
 * (see {@link CommandDef.Inherited}); `examples` feed help. `inherits` (type-only) names a nested
 * command's ancestors so the fields it passes down accumulate theirs; the returned spec carries
 * them for its actions' `inherits`, and `actions` must not expect more than it passes down.
 */
export const defineCommand = <
  TContext = unknown,
  TArgs extends unknown[] = [],
  S extends StandardSchemaV1 | undefined = undefined,
  P extends CommandDef.Inherits | undefined = undefined,
>(
  options: CommandDef.Options<TContext, TArgs, S, P>,
): CommandDef.Spec<TContext, TArgs, CommandDef.Available<P, S>, CommandDef.InheritedOf<P>> => {
  const leaf: Record<string, CommandDef.Action<AnyType, AnyType, AnyType>> = {}
  const subs: Record<string, CommandDef.Spec> = {}

  for (const [key, member] of Object.entries(options.actions)) {
    if ((member as { _st?: symbol })._st === COMMAND) {
      subs[key] = member as CommandDef.Spec
    } else {
      leaf[key] = member as CommandDef.Action<AnyType, AnyType, AnyType>
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
    inherit:
      options.input === undefined && options.options === undefined
        ? undefined
        : { input: options.input, options: options.options, short: options.short },
    examples: options.examples,
  } as CommandDef.Spec<TContext, TArgs, CommandDef.Available<P, S>, CommandDef.InheritedOf<P>>
}
