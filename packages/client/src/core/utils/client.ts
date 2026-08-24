import type { Operation } from 'std:effect'
import { attempt, createFutureFlow, toFuture, useScope } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { Ws } from 'std:ws'

import { JsonCodec } from 'std:codec/impl/json'
import { WebIO } from 'std:io/impl/web'

import { Client } from '../definition/client'
import { heldReadable, holdOf } from '../internal/future'
import { request } from '../internal/http'
import { actionOf, manifestOf } from '../internal/manifest'
import { rows, watch } from '../internal/realtime'
import type { ClientDef } from '../types/client'

/**
 * A typed client: `client.<service>.<action>(input, options?)` for every action the manifest
 * lists — GET/DELETE inputs travel as query + path params, other methods as JSON / a stream body /
 * multipart; outputs decode by `oz-brand` (values, ndjson/sse → `FutureFlow`, text, bytes →
 * stream); server failures come back as Result failures with their own tag and `req:<id>` cause.
 *
 * Every call is a `Future`: `yield*` it (inline in the caller's task — effect semantics intact)
 * or `await` it (a detached job of the client's scope — promise semantics intact). Streams are
 * std `FutureFlow`s: `yield*` as a Flow or `for await` as an async iterable.
 */
export function* createClient<TApi = Record<string, Record<string, ClientDef.Ref>>>(
  options: ClientDef.Options,
): Operation<ClientDef.Handle<TApi>> {
  // ids (request ids, watch ids) come from the IO protocol: give it a default impl when the
  // scope has none (WebIO rides WebCrypto — browser, bun and node alike)
  if (isFailure(yield* attempt(() => IO.actions.uuid()))) {
    yield* WebIO.use()
  }

  // the realtime frames ride the codec protocol: JSON unless one is already registered here
  yield* attempt(() => JsonCodec.use())

  if (!(yield* Ws.context.get())) {
    yield* Ws.use()
  }

  // `$setToken` overrides the option; until the first set, the given value/resolver answers
  let tokenOverride: string | null | undefined
  const ctx = yield* Client.use({
    ...options,
    token: () => {
      if (tokenOverride !== undefined) {
        return tokenOverride ?? undefined
      }
      return typeof options.token === 'function' ? options.token() : options.token
    },
  })

  // the scope the client lives in: awaited futures and `for await`ed flows run as ITS jobs, so
  // they see the contexts installed above (keep the scope alive as long as the client is used)
  const scope = yield* useScope()

  // ONE request op both worlds run: streams come back consumable on either side — flows as
  // FutureFlows, bytes as a held stream — and the awaited task waits for their consumption
  const callOp = (
    target: ClientDef.Target,
    input: unknown,
    callOptions: ClientDef.CallOptions | undefined,
  ) =>
    function* (): Operation<{ value: unknown; meta: ClientDef.Meta }> {
      const [service, action] =
        typeof target === 'string'
          ? (target.split('.') as [string, string])
          : [target.service, target.action]
      const def = yield* actionOf(ctx, service, action)
      const { value, meta } = yield* request({ ctx, action: def, input, options: callOptions })

      if (meta.brand === 'ndjson' || meta.brand === 'sse') {
        return { value: createFutureFlow(scope, value as AnyType), meta }
      }

      if (value instanceof ReadableStream) {
        return { value: heldReadable(value as ReadableStream<Uint8Array>), meta }
      }

      return { value, meta }
    }

  const callWithMeta: ClientDef.Statics['$callWithMeta'] = (target, input, callOptions) =>
    toFuture(scope, callOp(target, input, callOptions), {
      signal: callOptions?.signal,
      hold: reply => holdOf(reply.value),
    })

  const call: ClientDef.Statics['$call'] = (target, input, callOptions) =>
    toFuture(
      scope,
      function* () {
        const { value } = yield* callOp(target, input, callOptions)()
        return value
      },
      { signal: callOptions?.signal, hold: value => holdOf(value) },
    )

  const statics: ClientDef.Statics = {
    $call: call,
    $callWithMeta: callWithMeta,
    $manifest: () => toFuture(scope, () => manifestOf(ctx)),
    $watch: <TRow>(resource: string, watchOptions?: ClientDef.WatchOptions) =>
      createFutureFlow(scope, watch<TRow>(ctx, resource, watchOptions)),
    $rows: <TRow>(resource: string, watchOptions?: ClientDef.WatchOptions) =>
      createFutureFlow(scope, rows<TRow>(ctx, resource, watchOptions)),
    $lastRequestId: () => ctx.lastRequestId,
    $setToken: token => {
      tokenOverride = token
    },
  }

  const serviceProxy = (service: string): unknown =>
    new Proxy(
      {},
      {
        get: (_target, action) =>
          typeof action === 'string'
            ? (input?: unknown, callOptions?: ClientDef.CallOptions) =>
                call({ service, action }, input, callOptions)
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
      if (key === 'then') {
        return undefined
      }
      return serviceProxy(key)
    },
  }) as AnyType
}
