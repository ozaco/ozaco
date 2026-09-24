import { CliCauses, CliErrors, describeFailure, isReported, Terminal } from 'cli:core'
import { usePalette } from 'cli:palette'
import type { Operation } from 'std:effect'
import { attempt, useContext } from 'std:effect'
import { appendCauses, fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { VERSION_FLAGS } from '../const'
import { Registry } from '../registry'
import type { CommandDef } from '../types/command'
import type { Helpers } from '../types/helpers'
import type { RegistryDef } from '../types/registry'

import { hasFlag, processArgv } from './argv'
import { renderProgramHelp } from './help'
import { buildNode } from './node'
import { runCommand } from './run'

function* program(args: string[], options: RegistryDef.RunOptions): Operation<void> {
  const ctx = yield* useContext(Registry)
  const palette = yield* usePalette()
  const head = args[0]

  if (head !== undefined && !head.startsWith('-')) {
    const node = ctx.commands.get(head) as AnyType as Helpers.RuntimeNode | undefined
    if (node !== undefined) {
      return yield* runCommand(node, args.slice(1), options)
    }
    const help = renderProgramHelp(ctx, palette)
    yield* Terminal.actions.write(
      `${palette.colors.error(`Unknown command '${head}'`)}\n\n${help}\n`,
      { stream: 'stderr' },
    )
    return yield* fail(CliErrors.Unknown, `Unknown command '${head}'`, CliCauses.Reported)
  }

  if (ctx.version !== undefined && hasFlag(args, VERSION_FLAGS)) {
    yield* Terminal.actions.write(`${ctx.version}\n`)
    return
  }

  yield* Terminal.actions.write(`${renderProgramHelp(ctx, palette)}\n`)
}

export function* register(command: RegistryDef.Command) {
  const spec = command as AnyType as CommandDef.Spec
  const node = buildNode(spec, spec.name)
  // Build + store the node only — do NOT run the command's `setup` here. Setup runs LAZILY when
  // the command is actually dispatched (see `runCommand`), in its own scope. Running it eagerly at
  // register would fire EVERY registered top-level command's setup in the shared registry scope, so
  // two commands that install the same protocol impl (e.g. two plugins both `YamlCodec.use()`)
  // collide — the multi-plugin host case, where all installed plugins are registered up front just
  // to populate `--help`. Program help only reads name/description off the stored node, never the
  // setup.
  const ctx = yield* useContext(Registry)
  ctx.commands.set(node.name, node as AnyType as RegistryDef.Command)
}

export function* get(name: string) {
  const ctx = yield* useContext(Registry)
  return ctx.commands.get(name)
}

/**
 * Dispatch argv. Parse errors and unknown commands are rendered here (message + help, on stderr)
 * and fail marked `CliCauses.Reported`. With `{ report: true }` a failing handler is rendered too —
 * once, as `tag: message` + causes — and marked, so the caller checks `isReported` instead of
 * logging it a second time. The failure is still returned (for the exit code).
 */
export function* run(argv?: string[], options: RegistryDef.RunOptions = {}) {
  const args = (argv ?? processArgv()).slice()

  if (options.report !== true) {
    return yield* program(args, options)
  }

  const outcome = yield* attempt(() => program(args, options))
  if (!isFailure(outcome)) {
    return
  }
  if (!isReported(outcome)) {
    const palette = yield* usePalette()
    yield* Terminal.actions.write(`${palette.colors.error(describeFailure(outcome))}\n`, {
      stream: 'stderr',
    })
    appendCauses(outcome, CliCauses.Reported)
  }
  return yield* outcome
}
