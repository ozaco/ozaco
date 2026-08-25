import type { Flow, Operation } from 'std:effect'

/** Drain a flow, returning every emitted value plus the close value it settles with. */
export function* drain<T, R>(source: Flow<T, R>): Operation<{ values: T[]; close: R }> {
  const subscription = yield* source
  const values: T[] = []
  for (;;) {
    const step = yield* subscription.next()
    if (step.done) {
      return { values, close: step.value }
    }
    values.push(step.value)
  }
}

/** Concatenate byte chunks. */
export const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}
