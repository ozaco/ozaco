// oxlint-disable import/exports-last
import { createSignal, operation } from 'std:effect'

import type { BusEvent, ChangeBus } from './types/change'

/** A single-process, multi-endpoint {@link ChangeBus} — the reference implementation and the test
 * double for multi-node reactivity: every `endpoint(origin)` shares one event stream, so several
 * `DbClient` scopes in one process behave like nodes on a real bus. */
export interface MemoryBus {
  endpoint(origin: string): ChangeBus
}

export const createMemoryBus = (): MemoryBus => {
  const stream = createSignal<BusEvent, never>()
  return {
    endpoint: origin => ({
      origin,
      publish: operation(function* (events: readonly BusEvent[]) {
        for (const event of events) {
          stream.send(event)
        }
      }),
      events: stream,
    }),
  }
}
