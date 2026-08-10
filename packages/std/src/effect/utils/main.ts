import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { call, callcc } from '../base/call'
import { useScope } from '../base/hooks'
import { ExitContext } from '../internal/contexts'
import type { Operation } from '../types/operation'
import type { Utils } from '../types/utils'

import { run } from './run'
import { withHost } from './with-host'

declare const Deno: AnyType

/** Exit the enclosing `main` with the given status. */
export function* exit(status: number, message?: string): Operation<void> {
  const escape = yield* ExitContext.expect()

  yield* escape({ status, message })
}

/**
 * A complete-program entry point: runs `body`, wires SIGINT/SIGTERM into a graceful shutdown, and
 * exits the process with the resulting status.
 */
export async function main(body: (args: string[]) => Operation<void>): Promise<void> {
  let hardexit = (_status: number) => {}

  const outcome = await run(() =>
    callcc<Utils.Exit>(function* (resolve) {
      yield* ExitContext.set(resolve)

      const interval = setInterval(() => {}, 2 ** 30)

      const scope = yield* useScope()

      try {
        const interrupt = {
          SIGINT: () => scope.run(() => resolve({ status: 130, signal: 'SIGINT' })),
          SIGTERM: () => scope.run(() => resolve({ status: 143, signal: 'SIGTERM' })),
        }

        yield* withHost({
          *deno() {
            hardexit = status => Deno.exit(status)
            try {
              Deno.addSignalListener('SIGINT', interrupt.SIGINT)
              /**
               * Windows only supports ctrl-c (SIGINT), ctrl-break (SIGBREAK), and ctrl-close (SIGUP)
               */
              if (Deno.build.os !== 'windows') {
                Deno.addSignalListener('SIGTERM', interrupt.SIGTERM)
              }
              yield* body(Deno.args.slice())
            } finally {
              Deno.removeSignalListener('SIGINT', interrupt.SIGINT)
              if (Deno.build.os !== 'windows') {
                Deno.removeSignalListener('SIGTERM', interrupt.SIGTERM)
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
            try {
              process.on('SIGINT', interrupt.SIGINT)
              if (process.platform !== 'win32') {
                process.on('SIGTERM', interrupt.SIGTERM)
              }
              yield* body(process.argv.slice(2))
            } finally {
              process.off('SIGINT', interrupt.SIGINT)
              if (process.platform !== 'win32') {
                process.off('SIGTERM', interrupt.SIGINT)
              }
            }
          },
          *browser() {
            try {
              self.addEventListener('unload', interrupt.SIGINT)
              yield* body([])
            } finally {
              self.removeEventListener('unload', interrupt.SIGINT)
            }
          },
        })

        yield* exit(0)
      } catch (error) {
        yield* resolve({ status: 1, error })
      } finally {
        clearInterval(interval)
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

  if (result.error) {
    console.error(result.error)
  }

  hardexit(result.status)
}
