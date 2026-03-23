import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { call } from './call'
import { callcc } from './callcc'
import { createContext } from './context'
import { run } from './run'
import { useScope } from './scope'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

export function* exit(status: number, message?: string): Operation<void> {
  let escape = yield* ExitContext.expect()
  let payload: Helpers.Exit = { status }
  if (message !== undefined) {
    payload.message = message
  }
  yield* escape(payload)
}

export async function main(body: (args: string[]) => Operation<void>): Promise<void> {
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  let hardexit = (_status: number) => {}

  let result = await run(() =>
    callcc<Helpers.Exit>(function* (resolve) {
      yield* ExitContext.set(resolve)

      let interval = setInterval(() => {}, Math.pow(2, 30))

      let scope = yield* useScope()

      try {
        let interrupt = {
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
            let { default: process } = yield* call<AnyType>(
              () => Function('return import("node:process")')() as Promise<AnyType>,
            )
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

    return hardexit(exitValue.status)
  }

  console.error('unknown error', result)

  return hardexit(1)
}

const ExitContext = createContext<(exit: Helpers.Exit) => Operation<void>>('exit')

declare const Deno: AnyType

function* withHost<T>(op: Helpers.HostOperation<T>): Operation<T> {
  let global = globalThis as Record<string, unknown>

  if (typeof global.Deno !== 'undefined') {
    return yield* op.deno()
  } else if (
    Object.prototype.toString.call(typeof global.process !== 'undefined' ? global.process : 0) ===
    '[object process]'
  ) {
    return yield* op.node()
  }
  return yield* op.browser()
}
