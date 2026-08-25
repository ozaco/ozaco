import type { Operation } from 'std:effect'
import { fork, operation, resource } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import pkg from '../../package.json'

import { ansi } from './const'
import { CliErrors } from './errors'
import { acquireLease, leaseStateOf, releaseLease } from './internal/lease'
import { eraseCodes, rowsOf } from './internal/region'
import type { TerminalDef } from './types/terminal'

/**
 * The core `renderer` handler — live-region arbitration. Only ONE live region exists at a time:
 * spinner, live table and prompt frames all draw through a lease, so they can never interleave and
 * the cursor/screen are restored on every exit path (done, failure, halt). The lease is a resource
 * bound to the acquiring scope; `done()` commits + releases early.
 */
const renderer = function* (
  options?: TerminalDef.RendererOptions,
): Operation<TerminalDef.Renderer> {
  const info = yield* Terminal.context.expect()
  const state = leaseStateOf(info)
  const interactive = info.capabilities.interactive

  return yield* resource<TerminalDef.Renderer>(function* (provide) {
    let held = false
    const region = { columns: 80, rows: 0, frame: '', closed: false }

    try {
      yield* acquireLease(state, options?.wait ?? false)
      held = true

      region.columns = (yield* Terminal.actions.size()).columns
      if (interactive) {
        yield* Terminal.actions.write(ansi.hideCursor)
      }

      const draw = operation(function* (frame: string) {
        const codes = eraseCodes(region.rows)
        region.frame = frame
        region.rows = rowsOf(frame, region.columns)
        yield* Terminal.actions.write(codes + frame)
      })

      const lease: TerminalDef.Renderer = {
        render: operation(function* (frame: string) {
          if (region.closed || !interactive) {
            return
          }
          yield* draw(frame)
        }),

        clear: operation(function* () {
          if (region.closed || !interactive) {
            return
          }
          const codes = eraseCodes(region.rows)
          region.rows = 0
          region.frame = ''
          if (codes !== '') {
            yield* Terminal.actions.write(codes)
          }
        }),

        done: operation(function* (frame?: string) {
          if (region.closed) {
            return
          }
          region.closed = true
          const codes = interactive ? eraseCodes(region.rows) : ''
          region.rows = 0
          const text = frame === undefined ? '' : `${frame}\n`
          const cursor = interactive ? ansi.showCursor : ''
          if (codes + text + cursor !== '') {
            yield* Terminal.actions.write(codes + text + cursor)
          }
          releaseLease(state)
        }),
      }

      if (info.capabilities.resize && interactive) {
        // subscribe HERE, then fork the drain — a forked subscribe races the first event
        const sizes = yield* yield* Terminal.actions.resize()
        yield* fork(function* () {
          let next = yield* sizes.next()
          while (next.done !== true) {
            region.columns = next.value.columns
            if (!region.closed && region.frame !== '') {
              yield* draw(region.frame)
            }
            next = yield* sizes.next()
          }
        })
      }

      yield* provide(lease)
    } finally {
      if (held && !region.closed) {
        region.closed = true
        // abrupt exit (failure/halt): wipe the leftover frame and restore the cursor
        const codes = interactive ? eraseCodes(region.rows) + ansi.showCursor : ''
        if (codes !== '') {
          yield* Terminal.actions.write(codes)
        }
        releaseLease(state)
      }
    }
  })
}

/**
 * The terminal binding protocol. Each platform binding is an impl of this protocol (packaged
 * `cli:impl/*` modules are planned); an impl owns the streams, raw mode, signal wiring and size
 * probing, detects its {@link TerminalDef.Capabilities} once at setup, and exposes the portable
 * action surface. Not cloneable — one terminal per scope. `resize` is capability-gated with a
 * failing protocol default; `renderer` is a protocol-level handler implemented once here in core.
 */
export const Terminal = defineProtocol<TerminalDef.Info, TerminalDef.Actions, TerminalDef.Handlers>(
  {
    name: 'cli-terminal',
    version: pkg.version,
    description: 'Platform terminal binding: streams in, capabilities + portable actions out',
    defaults: {
      resize: operation(function* () {
        return yield* fail(
          CliErrors.Unsupported,
          'the installed terminal does not support resize events',
        )
      }) as AnyType,
    },
    handlers: {
      renderer,
    },
  },
)

/** Resolve the installed terminal's info (`{ terminal, capabilities }`); install an impl first. */
export const useTerminal = (): Operation<TerminalDef.Info> => Terminal.context.expect()

/**
 * Typed fallbacks for the capability-gated actions — spread these into `build({...})` and override
 * only what the platform actually supports:
 * `Terminal.implement({...}).build({ ...terminalDefaults('x'), write, … })`.
 */
export const terminalDefaults = (terminal: string): Pick<TerminalDef.Actions, 'resize'> => ({
  resize: operation(function* () {
    return yield* fail(
      CliErrors.Unsupported,
      `the "${terminal}" terminal does not support resize events`,
    )
  }) as AnyType,
})
