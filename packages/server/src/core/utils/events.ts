import type { Operation } from 'std:effect'
import { attempt, fork } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { ActiveSpan, isTracing, newTraceId } from 'std:trace'

import { ActiveRequest, RequestRef } from '../context'
import { Server } from '../definition/protocol'
import { SUBSCRIPTION_KEY } from '../internal/const'
import { unhandled } from '../internal/events'
import type { EventsDef } from '../types/events'
import type { ServerDef } from '../types/server'

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
 *
 *   // a handler: every occurrence runs in its CONSUMER span `process media.uploaded`
 *   yield* events.handle('media.uploaded', function* (upload, { origin }) {
 *     upload.size                                  // number
 *   })
 *
 *   // or pull them yourself (payloads only, under whatever span is active)
 *   const feed = yield* events.on('media.uploaded')
 *   step.value.size                              // number
 *
 * `ctx.emit` / `Server.actions.events` stay as the untyped plane underneath — this is the typed
 * face of the same wire, so an event emitted either way is seen by both.
 */
export const defineEvents = <const TMap extends EventsDef.Map>(
  map: TMap,
): EventsDef.Handle<TMap> => {
  const where = (name: string): string => `payload of event "${name}"`

  /**
   * One occurrence through `handler`, in its CONSUMER span (`Server.actions.process`): a trace
   * of its own continuing the emitter's (parent = the creation context, the `creation` link) —
   * never the span or request `handle` was called under, which the loop outlives. A payload
   * that does not match fails the span (a 400: WARN), a failing handler fails it (ERROR for a
   * 5xx) — recorded there, ONCE; with tracing off it is logged instead. Never fails the loop.
   */
  function* handleOne(
    item: ServerDef.EventItem,
    handler: EventsDef.Handler<AnyType>,
    options: EventsDef.HandleOptions | undefined,
  ): Operation<void> {
    const request = new ActiveRequest(item.requestId || (yield* newTraceId()), 'internal')

    const outcome = yield* RequestRef.with(request, () =>
      ActiveSpan.with(null, () =>
        attempt(() =>
          Server.actions.process(item, function* (span) {
            span.setAttribute('ozaco.event.origin', item.origin)

            if (options?.subscription) {
              span.setAttribute(SUBSCRIPTION_KEY, options.subscription)
            }

            const payload = yield* validate<AnyType>(
              map[item.name]!,
              item.payload,
              where(item.name),
            )
            yield* handler(payload, { origin: item.origin, trace: item.trace })
          }),
        ),
      ),
    )

    if (isFailure(outcome) && !(yield* isTracing())) {
      yield* unhandled(item, outcome, options)
    }
  }

  return {
    names: Object.keys(map) as EventsDef.Name<TMap>[],

    *emit(name, payload) {
      // validated at the SOURCE: a malformed payload is the emitter's bug, and it can still be
      // fixed here — once it is on the wire every subscriber has to cope with it
      const checked = yield* validate(map[name]!, payload, where(name))
      yield* Server.actions.emit(name, checked)
    },

    on: ((name: string) => ({
      *[Symbol.iterator]() {
        const source = yield* Server.actions.events(name)

        return {
          *next(): Operation<AnyType> {
            for (;;) {
              const step = yield* source.next()

              if (step.done) {
                return step
              }

              const item = step.value
              const checked = yield* attempt(() => validate(map[name]!, item.payload, where(name)))

              if (!isFailure(checked)) {
                return { done: false as const, value: checked.value }
              }

              // a bad publisher must not break its subscribers: drop it, but say so — the item
              // is processed in its CONSUMER span (linked to the emitter's), which the
              // validation failure fails (a 400: `error.type`, one WARN exception record)
              yield* attempt(() =>
                Server.actions.process(item, function* (span) {
                  span.setAttribute('ozaco.event.origin', item.origin)
                  return yield* checked
                }),
              )
            }
          },
        }
      },
    })) as EventsDef.Handle<TMap>['on'],

    handle: ((
      name: string,
      handler: EventsDef.Handler<AnyType>,
      options?: EventsDef.HandleOptions,
    ) => ({
      *[Symbol.iterator]() {
        // subscribed HERE, before the loop starts: an event emitted once `handle` returned is
        // handled (a fork only runs to its first suspension point before it returns)
        const source = yield* Server.actions.events(name)

        return yield* fork(function* () {
          for (;;) {
            const step = yield* source.next()

            // the event plane closed (the carrier / transport is gone): the loop is done
            if (step.done) {
              return
            }

            yield* handleOne(step.value, handler, options)
          }
        })
      },
    })) as EventsDef.Handle<TMap>['handle'],
  }
}
