import { Palette, Registry, Terminal } from 'cli:core'
import type { RegistryDef } from 'cli:core'
import { operation, useContext } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { CommandErrors, VERSION_FLAGS } from '../const'
import type { CommandDef } from '../types/command'

import { renderProgramHelp } from './help'
import { runCommand } from './run'

const hasFlag = (argv: string[], flags: string[]): boolean =>
  argv.some(token => flags.includes(token))

export const register = operation(function* (command: RegistryDef.Command) {
  yield* install(command as AnyType)
  const ctx = yield* useContext(Registry)
  ctx.commands.set(command.name, command)
})

export const get = operation(function* (name: string) {
  const ctx = yield* useContext(Registry)
  return ctx.commands.get(name)
})

export const run = operation(function* (argv?: string[]) {
  const ctx = yield* useContext(Registry)
  const palette = yield* useContext(Palette)
  const fromProcess = typeof process === 'undefined' ? [] : process.argv.slice(2)
  const args = (argv ?? fromProcess).slice()
  const head = args[0]

  if (head !== undefined && !head.startsWith('-')) {
    const command = ctx.commands.get(head)
    if (command !== undefined) {
      return yield* runCommand(
        command as CommandDef.Command<AnyType, AnyType, AnyType>,
        args.slice(1),
      )
    }
    const help = renderProgramHelp(ctx, palette)
    yield* Terminal.actions.write(
      `${palette.colors.error(`unknown command: ${head}`)}\n\n${help}\n`,
    )
    return yield* fail(CommandErrors.Unknown, `unknown command: ${head}`)
  }

  if (ctx.version !== undefined && hasFlag(args, VERSION_FLAGS)) {
    yield* Terminal.actions.write(`${ctx.version}\n`)
    return
  }

  yield* Terminal.actions.write(`${renderProgramHelp(ctx, palette)}\n`)
})
