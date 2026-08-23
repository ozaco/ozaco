import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { Ws } from 'std:ws'

import { JsonCodec } from 'std:codec/impl/json'
import { WebIO } from 'std:io/impl/web'

import { Client } from '../definition/client'
import { request } from '../internal/http'
import { actionOf, manifestOf } from '../internal/manifest'
import { rows, watch } from '../internal/realtime'
import type { ClientDef } from '../types/client'

/**
 * A typed client: `client.<service>.<action>(input, options?)` for every action the manifest
 * lists — GET/DELETE inputs travel as query + path params, other methods as JSON / a stream body /
 * multipart; outputs decode by `oz-brand` (values, ndjson/sse → Flow, text, bytes → stream);
 * server failures come back as Result failures with their own tag and `req:<id>` cause.
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

  const ctx = yield* Client.use(options)

  const callWithMeta: ClientDef.Statics['$callWithMeta'] = function* (target, input, callOptions) {
    const [service, action] =
      typeof target === 'string'
        ? (target.split('.') as [string, string])
        : [target.service, target.action]
    const def = yield* actionOf(ctx, service, action)

    return yield* request({ ctx, action: def, input, options: callOptions })
  }

  const call: ClientDef.Statics['$call'] = function* (target, input, callOptions) {
    const { value } = yield* callWithMeta(target, input, callOptions)
    return value
  }

  const statics: ClientDef.Statics = {
    $call: call,
    $callWithMeta: callWithMeta,
    $manifest: () => manifestOf(ctx),
    $watch: <TRow>(resource: string, watchOptions?: ClientDef.WatchOptions) =>
      watch<TRow>(ctx, resource, watchOptions),
    $rows: <TRow>(resource: string, watchOptions?: ClientDef.WatchOptions) =>
      rows<TRow>(ctx, resource, watchOptions),
    $lastRequestId: () => ctx.lastRequestId,
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
