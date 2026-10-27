import { asFailure, formatFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { call, callcc } from '../base/call'
import { useScope } from '../base/hooks'
import { ExitContext } from '../internal/contexts'
import type { Operation } from '../types/operation'
import type { Utils } from '../types/utils'

import { run } from './run'
import { withHost } from './with-host'

declare const Deno: AnyType

/** The signals `main` wires by default, and what they exit with. */
const DEFAULT_SIGNALS: Readonly<Record<string, number>> = { SIGINT: 130, SIGTERM: 143 }

/** The signals a Windows process can receive. */
const WINDOWS_SIGNALS: ReadonlySet<string> = new Set(['SIGINT', 'SIGBREAK'])

/** Exit the enclosing `main` with the given status. */
export function* exit(status: number, message?: string): Operation<void> {
  const escape = yield* ExitContext.expect()

  yield* escape({ status, message })
}

/**
 * A complete-program entry point: runs `body`, wires the stop signals (SIGINT / SIGTERM, plus
 * `options.signals`) into a graceful shutdown — bounded by `deadlineMs` when given — and exits
 * the process with the resulting status; `unhandledRejection` says what a stray rejection does.
 */
export async function main(
  body: (args: string[]) => Operation<void>,
  options?: Utils.MainOptions,
): Promise<void> {
  let hardexit = (_status: number) => {}

  const signals = { ...DEFAULT_SIGNALS, ...options?.signals }
  const outcome = await run(() =>
    callcc<Utils.Exit>(function* (resolve) {
      yield* ExitContext.set(resolve)

      const interval = setInterval(() => {}, 2 ** 30)

      const scope = yield* useScope()
      let asked = false

      /** The shutdown a signal asks for — once; the deadline (if any) ends a slow teardown hard. */
      const stopWith = (status: number) => () => {
        if (asked) {
          return
        }

        asked = true
        scope.run(() => resolve({ status }))

        if (options?.deadlineMs !== undefined) {
          const timer = setTimeout(() => hardexit(status), options.deadlineMs)

          ;(timer as { unref?: () => void }).unref?.()
        }
      }

      const onRejection = (reason: unknown) => {
        if (options?.unhandledRejection === 'exit') {
          scope.run(() => resolve({ status: 1, error: reason }))

          return
        }

        console.error(formatFailure(asFailure(reason), { chain: true }))
      }

      const interrupt = Object.fromEntries(
        Object.entries(signals).map(([signal, status]) => [signal, stopWith(status)]),
      )

      try {
        yield* withHost({
          *deno() {
            hardexit = status => Deno.exit(status)

            const wired = Object.entries(interrupt).filter(
              ([signal]) => Deno.build.os !== 'windows' || WINDOWS_SIGNALS.has(signal),
            )

            try {
              for (const [signal, handler] of wired) {
                Deno.addSignalListener(signal, handler)
              }

              if (options?.unhandledRejection) {
                globalThis.addEventListener('unhandledrejection', rejectionEvent)
              }

              yield* body(Deno.args.slice())
            } finally {
              for (const [signal, handler] of wired) {
                Deno.removeSignalListener(signal, handler)
              }

              if (options?.unhandledRejection) {
                globalThis.removeEventListener('unhandledrejection', rejectionEvent)
              }
            }
          },
          *node() {
            // Annotate dynamic import so that webpack ignores it.
            // See https://webpack.js.org/api/module-methods/#webpackignore
            const { default: process } = yield* call(
              () => import(/* webpackIgnore: true */ 'node:process'),
            )

            // oxlint-disable-next-line unicorn/no-process-exit
            hardexit = status => process.exit(status)

            const wired = Object.entries(interrupt).filter(
              ([signal]) => process.platform !== 'win32' || WINDOWS_SIGNALS.has(signal),
            )

            try {
              for (const [signal, handler] of wired) {
                process.on(signal as NodeJS.Signals, handler)
              }

              if (options?.unhandledRejection) {
                process.on('unhandledRejection', onRejection)
              }

              yield* body(process.argv.slice(2))
            } finally {
              for (const [signal, handler] of wired) {
                process.off(signal as NodeJS.Signals, handler)
              }

              if (options?.unhandledRejection) {
                process.off('unhandledRejection', onRejection)
              }
            }
          },
          *browser() {
            const unload = interrupt['SIGINT'] ?? stopWith(130)

            try {
              self.addEventListener('unload', unload)
              yield* body([])
            } finally {
              self.removeEventListener('unload', unload)
            }
          },
        })

        yield* exit(0)
      } catch (error) {
        yield* resolve({ status: 1, error })
      } finally {
        clearInterval(interval)
      }

      function rejectionEvent(event: { reason?: unknown; preventDefault?: () => void }): void {
        event.preventDefault?.()
        onRejection(event.reason)
      }
    }),
  )

  // the task's promise side resolves to a Result — a failure here means the run itself broke
  const result: Utils.Exit = isSuccess(outcome) ? outcome.value : { status: 1, error: outcome }

  if (result.message) {
    if (result.status === 0) {
      console.log(result.message)
    } else {
      console.error(result.message)
    }
  }

  // the whole cause chain, Java style (a foreign throw folded by `asFailure`)
  if (result.error) {
    console.error(formatFailure(asFailure(result.error), { chain: true }))
  }

  hardexit(result.status)
}
