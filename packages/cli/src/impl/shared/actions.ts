import type { Key, Size, TerminalDef } from 'cli:core'
import { CliErrors, Terminal } from 'cli:core'
import type { Operation } from 'std:effect'
import { createQueue, ensure, race, resource, withResolvers } from 'std:effect'
import { fail } from 'std:result'

import { decodeKeys } from './keys'
import type { Driver } from './types'

/** The body, unless the platform interrupt lands first — then the session fails `cli.cancelled`. */
function* raced<R>(body: () => Operation<R>, interrupt: Operation<void>): Operation<R> {
  return (yield* race([
    body(),

    (function* (): Operation<R> {
      yield* interrupt

      return yield* fail(CliErrors.Cancelled, 'interrupted')
    })(),
  ])) as R
}

/** the active session's key queue, per installed binding. */
const sessions = new WeakMap<Driver.Binding, ReturnType<typeof createQueue<Key, void>>>()

function* bindingOf(): Operation<Driver.Binding> {
  return (yield* Terminal.context.expect()) as Driver.Binding
}

/**
 * Build the whole `Terminal` action surface over a {@link Driver.Handle} — the same trick db uses
 * for its SQL adapters and transport for its drivers: the portable half is written ONCE, and a
 * binding brings only what the platform alone can give.
 *
 * The session is the delicate part: raw mode goes on, one key reader feeds the `keys()` flow, and
 * the restore runs on EVERY exit — success, failure, halt, interrupt — so a cancelled prompt never
 * leaves the tty raw with a hidden cursor.
 */
export const terminalActions = (): Pick<
  TerminalDef.Actions,
  'write' | 'size' | 'keys' | 'resize' | 'session'
> => ({
  *write(text: string) {
    ;(yield* bindingOf()).handle.write(text)
  },

  *size() {
    return (yield* bindingOf()).handle.size()
  },

  *keys() {
    const queue = sessions.get(yield* bindingOf())

    if (!queue) {
      return yield* fail(
        CliErrors.Terminal,
        'keys() needs an active session — call it inside Terminal.actions.session(...)',
      )
    }

    return {
      *[Symbol.iterator]() {
        return queue
      },
    }
  },

  *resize() {
    const { capabilities, handle } = yield* bindingOf()

    if (!capabilities.resize || !handle.onResize) {
      return yield* fail(
        CliErrors.Unsupported,
        'the installed terminal does not support resize events',
      )
    }

    const subscribe = handle.onResize

    return {
      *[Symbol.iterator]() {
        const queue = createQueue<Size, never>()
        const stop = subscribe(size => queue.add(size))
        yield* ensure(() => stop())

        return queue
      },
    }
  },

  *session(body) {
    const binding = yield* bindingOf()

    if (sessions.has(binding)) {
      return yield* fail(CliErrors.Busy, 'a terminal session is already running')
    }

    const { handle } = binding
    const queue = createQueue<Key, void>()
    const interrupted = withResolvers<void>('terminal interrupt')

    return yield* resource(function* (provide) {
      const restore = handle.raw()

      const detach = handle.listen(text => {
        for (const key of decodeKeys(text)) {
          queue.add(key)
        }
      })

      const release = handle.onInterrupt?.(() => interrupted.resolve(undefined))
      sessions.set(binding, queue)

      try {
        return yield* provide(yield* raced(body, interrupted.operation))
      } finally {
        sessions.delete(binding)
        release?.()
        detach()
        restore()
        queue.close(undefined)
      }
    })
  },
})
