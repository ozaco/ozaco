import type { AnyType } from 'std:shared'

import type { CommandDef } from '../types/command'

// Built plugins are frozen, so nested subcommands are tracked off-object, keyed by the command.
const subcommands = new WeakMap<
  object,
  Record<string, CommandDef.Command<AnyType, AnyType, AnyType>>
>()

export const setSubcommands = (
  command: object,
  value: Record<string, CommandDef.Command<AnyType, AnyType, AnyType>>,
): void => {
  subcommands.set(command, value)
}

export const getSubcommands = (
  command: object,
): Record<string, CommandDef.Command<AnyType, AnyType, AnyType>> => subcommands.get(command) ?? {}
