// oxlint-disable import/exports-last
import { defineProtocol } from 'std:plugin'

import { createRequestAction } from './internal'
import type { FetchDef } from './types'

/**
 * The fetch protocol handle: the routed `Fetch.actions.*` dispatch plus the hook surface. Usage is
 * two-step — `const res = yield* Fetch.actions.get(url)`, then `yield* res.json<T>()` (or
 * `yield* res.expect()` first). Every method delegates through the single `request` dispatch, so
 * `Fetch.around({ request })` (and `before`/`after`/`error`) middleware wraps the actual network
 * call no matter which method was used. Install {@link FetchClient} to provide the implementation;
 * without it any dispatch fails with `missing-action`.
 */
export const Fetch = defineProtocol<FetchDef.Context, FetchDef.Contract>({
  name: 'std/fetch',
  version: '0.0.0',
  description: 'HTTP client protocol: every request flows through the hookable `request` dispatch',
})

/** A verb shorthand: pins `method` and funnels into the ROUTED `request` dispatch (hookable). */
const method = (targetMethod: string) =>
  function* (input: RequestInfo | URL, init?: FetchDef.MethodInit) {
    return yield* FetchClient.actions.request(input, { ...init, method: targetMethod })
  }

/**
 * The platform-fetch implementation of the protocol: `install(FetchClient, { baseUrl, headers,
 * timeoutMs })` (all options optional — they become scope-wide defaults). The transport stays
 * injectable via the `fetchImpl` context.
 */
const FetchClientImpl = Fetch.implement<FetchDef.Context, [options?: FetchDef.Options]>({
  name: 'std/fetch',
  version: '0.0.0',
  description: 'Effect-native HTTP client over the platform fetch',

  *setup(options) {
    return {
      baseUrl: options?.baseUrl,
      headers: options?.headers,
      timeoutMs: options?.timeoutMs,
      codec: options?.codec,
    }
  },
})

export const FetchClient: FetchDef = FetchClientImpl.build({
  request: createRequestAction(FetchClientImpl.context),
  get: method('GET'),
  post: method('POST'),
  put: method('PUT'),
  patch: method('PATCH'),
  delete: method('DELETE'),
  head: method('HEAD'),
})
