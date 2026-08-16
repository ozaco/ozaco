import type { Flow, Operation, Queue, Subscription } from 'std:effect'
import { createQueue, each, operation } from 'std:effect'
import type { Result } from 'std:result'

import type { Multistream, Part, PartClose } from '../types/gateway'
import type { Wire } from '../types/wire'

/** Input planes travel on lanes named `in:<DataType>`; the output lane stays `'0'`. */
export const INPUT_LANE_PREFIX = 'in:'

export const inputLaneOf = (plane: string): string => `${INPUT_LANE_PREFIX}${plane}`

export const isInputLane = (lane: string): boolean => lane.startsWith(INPUT_LANE_PREFIX)

export const planeOfLane = (lane: string): string => lane.slice(INPUT_LANE_PREFIX.length)

/** Wraps a single-consumer subscription (queue) as a Flow — shared by carriers and the edge. */
export const flowOf = <T, TClose>(subscription: Subscription<T, TClose>): Flow<T, TClose> => ({
  *[Symbol.iterator]() {
    return subscription
  },
})

/**
 * CALLER side of a remote multipart plane: folds a {@link Multistream} into the shared
 * {@link Wire.PartFrame} vocabulary. The carrier supplies `emit` (worker: structured-clone envelope;
 * NATS: raw-payload chunk frames) — awaiting `emit` is the carrier's backpressure hook.
 */
export const pumpMultistream = operation(function* (
  source: Multistream,
  emit: (frame: Wire.PartFrame) => Operation<void>,
) {
  for (const part of yield* each(source.parts)) {
    if (part.kind === 'field') {
      yield* emit({ p: 'field', name: part.name, value: part.value })
    } else {
      yield* emit({
        p: 'file',
        name: part.name,
        filename: part.filename,
        contentType: part.contentType,
      })

      for (const chunk of yield* each(part.data)) {
        yield* emit({ p: 'chunk', data: chunk })
        yield* each.next()
      }

      yield* emit({ p: 'file-end' })
    }

    yield* each.next()
  }
})

export interface MultistreamAssembler {
  /** Push one decoded frame (sync — carriers call this from their readers). */
  push(frame: Wire.PartFrame): void
  /** Close the plane: clean end, or a Failure that re-raises in the consuming handler. */
  end(failure?: Result.Failure<unknown>): void
  readonly multistream: Multistream
}

/**
 * OWNER side of a remote multipart plane: rebuilds the {@link Multistream} a handler takes with
 * `useSource(DataType.multistream)` from the shared frame vocabulary.
 */
export const createMultistreamAssembler = (): MultistreamAssembler => {
  const parts = createQueue<Part, PartClose>()
  let file: Queue<Uint8Array, PartClose> | undefined

  return {
    push(frame: Wire.PartFrame) {
      if (frame.p === 'field') {
        parts.add({ kind: 'field', name: frame.name, value: frame.value })

        return
      }

      if (frame.p === 'file') {
        const data = createQueue<Uint8Array, PartClose>()

        file = data
        parts.add({
          kind: 'file',
          name: frame.name,
          filename: frame.filename,
          contentType: frame.contentType,
          data: flowOf(data),
        })

        return
      }

      if (frame.p === 'chunk') {
        file?.add(frame.data)

        return
      }

      file?.close(true)
      file = undefined
    },
    end(failure?: Result.Failure<unknown>) {
      file?.close(failure ?? true)
      file = undefined
      parts.close(failure ?? true)
    },
    multistream: { parts: flowOf(parts) },
  }
}
