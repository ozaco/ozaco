import type { AnyType } from 'std:shared'

import type { CommandDef } from '../types/command'

type SubcommandMap = WeakMap<object, Record<string, CommandDef.Command<AnyType, AnyType, AnyType>>>

// Built plugins are frozen, so nested subcommands are tracked off-object, keyed by the command.
//
// The map MUST be shared across bundles: plugins bundle their own copy of @ozaco/cli, so a
// module-local `new WeakMap()` would give each bundle its own instance — the plugin's
// `defineCommand` (setSubcommands) and the host's `runCommand` (getSubcommands) would look at
// different maps and every nested subcommand would vanish. Plugins are eval'd in-process (same
// realm/globalThis), so stashing one WeakMap on globalThis under a stable `Symbol.for` key gives
// exactly one instance per realm that every @ozaco/cli copy shares. The key is the (frozen) command
// object — `WeakMap.set` never mutates it, so freezing is fine. `??=` is idempotent: whichever cli
// copy loads first creates the map; the rest reuse it.
const REGISTRY = Symbol.for('cli:command:subcommands')
const store = globalThis as AnyType

const subcommands: SubcommandMap = (store[REGISTRY] ??= new WeakMap())

export const setSubcommands = (
  command: object,
  value: Record<string, CommandDef.Command<AnyType, AnyType, AnyType>>,
): void => {
  subcommands.set(command, value)
}

export const getSubcommands = (
  command: object,
): Record<string, CommandDef.Command<AnyType, AnyType, AnyType>> => subcommands.get(command) ?? {}
