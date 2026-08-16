import { createContext } from 'std:effect'
import type { Context } from 'std:effect'

import { connect } from '@nats-io/transport-node'

import type { Nats } from '../types'

/**
 * The connection factory the transport dials through. Defaults to `connect` from
 * `@nats-io/transport-node`; override it in the installing scope for fakes
 * (`natsImpl.set({ connect: fake })`) or to run on Deno via `@nats-io/transport-deno`.
 */
export const natsImpl: Context<Nats.ImplLike> = createContext<Nats.ImplLike>(
  'server:transport/nats',
  { connect: options => connect(options) },
)
