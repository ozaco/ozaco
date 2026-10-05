import type { Operation } from 'std:effect'
import { useContext } from 'std:effect'

import { StateRef } from './internal/driver'

/** The endpoint the `ZmqTransport` install in scope actually bound — `tcp://*:0` resolved to
 * its port — or `null` on an install that connects. What other processes `connect` to. */
export function* zmqEndpoint(): Operation<string | null> {
  return (yield* useContext(StateRef)).bound
}
