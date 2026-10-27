import type { Future, Operation } from 'std:effect'
import {
  attempt,
  createFuture,
  createFutureFlow,
  createScope,
  suspend,
  toFuture,
  within,
} from 'std:effect'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { createSession } from '../internal/session'
import { textOf } from '../internal/text'
import type { ClientDef } from '../types/client'

import { createClient } from './client'

/**
 * `connectClient` without the await: the handle comes back AT ONCE and every call, watch and
 * collection made on it waits for the client (the manifest, the plugins) by itself — a store or
 * a React effect holds one client from the first render, with no `await api()` in front of every
 * use and no `live` flag around a watch. `$session` and `$scope` are real from the start (a token
 * store needs no manifest), `$realtime.status()` is `idle` until the first watch, `$ready`
 * resolves the connected handle, `$close()` tears everything down.
 */
export const lazyClient = <TApi = Record<string, Record<string, ClientDef.Ref>>>(
  options: ClientDef.Options,
): ClientDef.LazyHandle<TApi> => {
  const [scope, destroy] = createScope()
  const ready = createFuture<ClientDef.Handle<TApi>>()
  let real: ClientDef.Handle<TApi> | null = null
  const session = createSession(
    {
      scope,
      given: () => (typeof options.token === 'function' ? options.token() : options.token),
      client: () => real as ClientDef.Handle<AnyType>,
      runIn: () => real?.$scope ?? scope,
    },
    options.session,
  )
  // `$realtime.subscribe` before the client exists: handed over once it does
  const pending = new Set<(status: ClientDef.RealtimeStatus) => void>()
  const handed = new Map<(status: ClientDef.RealtimeStatus) => void, () => void>()

  scope.run(
    function* () {
      const opened = yield* attempt(() => createClient<TApi>(options, { session }))

      if (isFailure(opened)) {
        ready.reject(opened)

        return
      }

      real = opened.value

      for (const listener of pending) {
        handed.set(listener, real.$realtime.subscribe(listener))
      }

      ready.resolve(real)
      yield* suspend()
    },
    { detached: true },
  )

  /** The handle, once it is. */
  function* handleOf(): Operation<ClientDef.Handle<TApi>> {
    return real ?? (yield* ready.future)
  }

  /** Run `op` on the handle INSIDE its scope — where its contexts (IO, codec, ws) live; a job
   * of the outer scope has none of them. */
  function* inside<T>(op: (handle: ClientDef.Handle<TApi>) => Operation<T>): Operation<T> {
    const handle = yield* handleOf()

    return yield* within(handle.$scope, () => op(handle))
  }

  /** A Future that waits for the handle, then runs `op` on it. */
  const deferred = <T>(op: (handle: ClientDef.Handle<TApi>) => Operation<T>): Future<T> =>
    toFuture(scope, () => inside(op))

  const close = () => Promise.resolve(destroy()).then(() => undefined)

  const collection = <TDoc extends { readonly _id: string }>(
    resource: string,
    collectionOptions?: ClientDef.CollectionOptions,
  ): ClientDef.Collection<TDoc> => {
    let inner: ClientDef.Collection<TDoc> | null = null
    let stopped = false

    function* innerOf(): Operation<ClientDef.Collection<TDoc>> {
      if (!inner) {
        inner = yield* inside(function* (handle) {
          return handle.$collection<TDoc>(resource, collectionOptions)
        })

        if (stopped) {
          inner.stop()
        }
      }

      return inner
    }

    /** A collection operation, in the handle's scope. */
    const through = <T>(op: (live: ClientDef.Collection<TDoc>) => Operation<T>): Future<T> =>
      toFuture(scope, function* () {
        const live = yield* innerOf()

        return yield* inside(() => op(live))
      })

    return {
      rows: () => inner?.rows() ?? [],
      load: () => through(live => live.load()),
      more: () => through(live => live.more()),
      hasMore: () => inner?.hasMore() ?? false,
      changes: createFutureFlow(scope, {
        *[Symbol.iterator]() {
          const live = yield* innerOf()

          return yield* inside(() => live.changes)
        },
      }),
      stop: () => {
        stopped = true
        inner?.stop()
      },
    }
  }

  const statics: ClientDef.Statics & {
    readonly $close: () => Promise<void>
    readonly $ready: Promise<ClientDef.ConnectedHandle<TApi>>
  } = {
    $call: (target, input, callOptions) =>
      deferred(handle => handle.$call(target, input, callOptions)),
    $callWithMeta: (target, input, callOptions) =>
      deferred(handle => handle.$callWithMeta(target, input, callOptions)),
    $manifest: () => deferred(handle => handle.$manifest()),
    $watch: <TRow>(resource: string, watchOptions?: ClientDef.WatchOptions) => {
      let turnTo: ((cursor: string | null, back?: boolean) => void) | null = null
      const turns: { readonly cursor: string | null; readonly back?: boolean | undefined }[] = []
      const flow = createFutureFlow(scope, {
        *[Symbol.iterator]() {
          return yield* inside(function* (handle) {
            const feed = handle.$watch<TRow>(resource, watchOptions)

            turnTo = feed.turn

            for (const turn of turns.splice(0)) {
              feed.turn(turn.cursor, turn.back)
            }

            return yield* feed
          })
        },
      })

      return Object.assign(flow, {
        turn: (cursor: string | null, back?: boolean) => {
          if (turnTo) {
            turnTo(cursor, back)
          } else {
            turns.push({ cursor, back })
          }
        },
      }) satisfies ClientDef.WatchFeed<TRow>
    },
    $rows: <TRow>(resource: string, watchOptions?: ClientDef.WatchOptions) =>
      createFutureFlow(scope, {
        *[Symbol.iterator]() {
          return yield* inside(handle => handle.$rows<TRow>(resource, watchOptions))
        },
      }),
    $window: <TRow>(resource: string, watchOptions?: ClientDef.WatchOptions) => {
      let inner: ClientDef.Window<TRow> | null = null
      const later: ((window: ClientDef.Window<TRow>) => void)[] = []
      const act = (step: (window: ClientDef.Window<TRow>) => void) => {
        if (inner) {
          step(inner)
        } else {
          later.push(step)
        }
      }

      return {
        rows: createFutureFlow(scope, {
          *[Symbol.iterator]() {
            return yield* inside(function* (handle) {
              inner ??= handle.$window<TRow>(resource, watchOptions)

              for (const step of later.splice(0)) {
                step(inner)
              }

              return yield* inner.rows
            })
          },
        }),
        page: () => inner?.page() ?? null,
        next: () => act(window => window.next()),
        prev: () => act(window => window.prev()),
        turn: (cursor, back) => act(window => window.turn(cursor, back)),
      } satisfies ClientDef.Window<TRow>
    },
    $lastRequestId: () => real?.$lastRequestId() ?? null,
    $lastTraceId: () => real?.$lastTraceId() ?? null,
    $scope: scope,
    $setToken: token => {
      if (token === null) {
        session.clear()
      } else {
        session.set({ accessToken: token })
      }
    },
    $session: session,
    $realtime: {
      status: () => real?.$realtime.status() ?? 'idle',
      subscribe: listener => {
        if (real) {
          return real.$realtime.subscribe(listener)
        }

        pending.add(listener)

        return () => {
          pending.delete(listener)
          handed.get(listener)?.()
          handed.delete(listener)
        }
      },
    },
    $collection: collection,
    $text: (failure, fallback) => textOf(options, failure, fallback),
    $close: close,
    $ready: Promise.resolve(ready.future).then(outcome => {
      const handle = unwrap(outcome as AnyType) as AnyType

      handle.$close = close

      return handle as ClientDef.ConnectedHandle<TApi>
    }),
  }

  const serviceProxy = (service: string): unknown =>
    new Proxy(
      {},
      {
        get: (_target, action) =>
          typeof action === 'string'
            ? (input?: unknown, callOptions?: ClientDef.CallOptions) =>
                deferred(handle => (handle as AnyType)[service][action](input, callOptions))
            : undefined,
      },
    )

  return new Proxy(statics, {
    get: (target, key) => {
      if (typeof key !== 'string') {
        return undefined
      }

      if (key in target) {
        return (target as AnyType)[key]
      }

      if (key === 'then' || key.startsWith('$')) {
        return undefined
      }

      return serviceProxy(key)
    },
  }) as unknown as ClientDef.LazyHandle<TApi>
}
