import { CliErrors, Terminal } from 'cli:core'
import { fail } from 'std:result'

import pkg from '../../../package.json'
import { terminalActions } from '../shared/actions'
import type { Driver } from '../shared/types'

import { detect } from './internal'
import type { NodeTerminalDef } from './types/node'

/**
 * The terminal on `process.stdin` / `process.stdout` — Node AND Bun, since Bun ships the same
 * `process` surface. Capabilities are read once at install (tty, `NO_COLOR`/`FORCE_COLOR`/
 * `COLORTERM`/`TERM`, the locale for unicode, `SIGWINCH` for resize) and `capabilities` overrides
 * whatever a flag says instead:
 *
 * ```ts
 * yield* NodeTerminal.use({ capabilities: { color: 'none' } })   // --no-color
 * ```
 */
export const NodeTerminal = Terminal.implement<Driver.Binding, [options?: NodeTerminalDef.Options]>(
  {
    name: 'cli-node-terminal',
    version: pkg.version,
    description: 'terminal on process.stdin / process.stdout (Node and Bun)',

    *setup(options?: NodeTerminalDef.Options) {
      const binding = detect(options?.capabilities)

      if (!binding) {
        return yield* fail(
          CliErrors.Unsupported,
          'no `process` here — NodeTerminal needs Node or Bun (use MemoryTerminal in tests)',
        )
      }

      return binding
    },
  },
).build(terminalActions())
