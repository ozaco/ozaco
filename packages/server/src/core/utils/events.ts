import type { Flow, Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { Server } from '../definition/protocol'
import type { EventsDef } from '../types/events'

import { tagOf } from './failure'
import { report } from './trace'
import { validate } from './validation'

/**
 * Declare the events an app broadcasts, ONCE, with the payload each one carries:
 *
 *   export const events = defineEvents({
 *     'todo.created': z.object({ id: z.string() }),
 *     'media.uploaded': z.object({ id: z.string(), size: z.number() }),
 *   })
 *
 *   yield* events.emit('todo.created', { id })   // name and payload both checked
 *   const feed = yield* events.on('media.uploaded')
 *   step.value.size                              // number
 *
 * `ctx.emit` / `Server.actions.events` stay as the untyped plane underneath — this is the typed
 * face of the same wire, so an event emitted either way is seen by both.
 */
export const defineEvents = <const TMap extends EventsDef.Map>(
  map: TMap,
): EventsDef.Handle<TMap> => ({
  names: Object.keys(map) as EventsDef.Name<TMap>[],

  *emit(name, payload) {
    // validated at the SOURCE: a malformed payload is the emitter's bug, and it can still be
    // fixed here — once it is on the wire every subscriber has to cope with it
    const checked = yield* validate(map[name]!, payload, `payload of event "${name}"`)
    yield* Server.actions.emit(name, checked)
  },

  on: ((name: string) => ({
    *[Symbol.iterator]() {
      const kernel = yield* Server.actions.describe()
      const source = yield* Server.actions.events(name)

      return {
        *next(): Operation<AnyType> {
          for (;;) {
            const step = yield* source.next()

            if (step.done) {
              return step
            }

            const checked = yield* attempt(() =>
              validate(map[name]!, step.value.payload, `payload of event "${name}"`),
            )

            if (!isFailure(checked)) {
              return { done: false as const, value: checked.value }
            }

            // a bad publisher must not break its subscribers: drop it, but say so
            yield* report(kernel, {
              t: 'failure',
              row: {
                request_id: null,
                span_id: null,
                tag: tagOf(checked),
                message: checked.message,
                status: 400,
                where: `event:${name}`,
                causes: [`origin:${step.value.origin}`],
                ts: Date.now(),
              },
            })
          }
        },
      }
    },
  })) as <TName extends EventsDef.Name<TMap>>(
    name: TName,
  ) => Flow<EventsDef.Received<TMap, TName>, never>,
})
