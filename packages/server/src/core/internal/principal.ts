import type { Operation } from 'std:effect'

import type { PrincipalInit } from '../types/broker'
import type { ActionRequest } from '../types/gateway'
import { ActionRequestContext } from '../utils/context'

/** The synthetic internal envelope {@link withPrincipal} runs its body under. */
const syntheticRequest = (init: PrincipalInit): ActionRequest => ({
  type: 'internal',
  method: 'INTERNAL',
  url: new URL('internal://broker/'),
  meta: {
    ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
    ...init.meta,
  },
})

/**
 * INTERNAL: the engine behind `CallOptions.principal` — runs `op` inside a synthetic `internal`
 * {@link ActionRequest} whose `meta` carries the given credentials, so everything that already
 * reads the envelope works unchanged: auth guards see the bearer token exactly as if an edge
 * delivered it, per-principal policy keys (cache/bucket) isolate on it, and the broker propagates
 * it across transports (`contexts.request`) so a cross-node dispatch authorizes the same way it
 * would locally. Any existing request context is REPLACED for the duration of `op`.
 *
 * The public surface is `Broker.actions.call(target, path, sources, { principal })` — this wrapper
 * stays private so identity is always declared AT the call.
 */
export const withPrincipal = <T>(
  init: PrincipalInit | string,
  op: () => Operation<T>,
): Operation<T> =>
  ActionRequestContext.with(syntheticRequest(typeof init === 'string' ? { token: init } : init), op)
