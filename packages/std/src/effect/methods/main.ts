import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { ExitContext } from '../internal/contexts'
import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { call } from './call'
import { callcc } from './callcc'
import { run } from './run'
import { useScope } from './scope'
import { withHost } from './with-host'

declare const Deno: AnyType

// One macrotask turn between the last teardown resolving and the hard exit. Native backends
// (an embedded database's threads, a driver's descriptors) may still be unwinding when their JS
// `close()` promise resolves; `process.exit` at that exact instant can segfault the native side.
// A single turn lets the loop drain what teardown started — it does not change the exit status.
const drain = (): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, 0)
  })

export function* exit(status: number, message?: string): Operation<void> {
  const escape = yield* ExitContext.expect()
  const payload: Helpers.Exit = { status }
  if (message !== undefined) {
    payload.message = message
  }
  yield* escape(payload)
}

export async function main(body: (args: string[]) => Operation<void>): Promise<void> {
  let hardexit = (_status: number) => {}

  const result = await run(() =>
    callcc<Helpers.Exit>(function* (resolve) {
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
            const { default: process } = yield* call<AnyType>(
              // oxlint-disable-next-line no-new-func
              () => Function('return import("node:process")')() as Promise<AnyType>,
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
                process.off('SIGTERM', interrupt.SIGTERM)
              }
            }
          },
          *bun() {
            const { default: process } = yield* call<AnyType>(
              // oxlint-disable-next-line no-new-func
              () => Function('return import("node:process")')() as Promise<AnyType>,
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
                process.off('SIGTERM', interrupt.SIGTERM)
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

  if (isSuccess(result)) {
    const exitValue = result.value

    if (exitValue.message) {
      if (exitValue.status === 0) {
        console.log(exitValue.message)
      } else {
        console.error(exitValue.message)
      }
    }

    if (exitValue.error) {
      console.error(exitValue.error)
    }

    await drain()
    return hardexit(exitValue.status)
  }

  console.error('unknown error', result)

  await drain()
  return hardexit(1)
}
