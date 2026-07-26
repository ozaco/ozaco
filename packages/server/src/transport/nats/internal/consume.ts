import type { Operation } from 'std:effect'
import { into, spawn, streamForEach } from 'std:effect'

/** Drive any NATS async iterable (a core Subscription, a JetStream ConsumerMessages) into a
 * per-message handler task. Spawned per message, so slow calls do not serialize the queue. */
export const consume = function* <T>(
  source: AsyncIterable<T>,
  handle: (item: T) => Operation<unknown>,
) {
  yield* spawn(function* () {
    yield* streamForEach(into<T>(source), item => spawn(() => handle(item)))
  })
}
