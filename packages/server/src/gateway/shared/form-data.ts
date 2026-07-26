import type { Source } from 'server:core'
import type { Operation, Stream, Subscription } from 'std:effect'
import type { StreamClose } from 'std:io'

/** Accumulate a repeated form key into an array instead of overwriting the earlier value. */
export const appendField = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (key in target) {
    const prev = target[key]
    target[key] = Array.isArray(prev) ? [...prev, value] : [prev, value]
  } else {
    target[key] = value
  }
}

/**
 * Split a multipart body at its FIRST FILE: the fields before it join the request body, everything
 * from that file on stays a streamed part.
 *
 * This is what lets an upload route keep a validated body without a buffered mode. Nothing is
 * spilled or held — the parser pauses AT the first file (it cannot yield the next part until the
 * current file drains, and we have not touched it), so pulling the leading fields costs exactly the
 * bytes of those fields. The convention it encodes is the one multipart already has: metadata
 * fields travel ahead of the payload (the same ordering S3's form upload mandates). A field that
 * arrives AFTER a file stays a part, in wire order.
 */
export const splitLeadingFields = function* (
  parts: Stream<Source.Part, StreamClose>,
  fields: Record<string, unknown>,
): Operation<Stream<Source.Part, StreamClose>> {
  // opening the subscription binds the parser's resource to the CURRENT (request) scope, which is
  // exactly the lifetime an upload has
  const subscription: Subscription<Source.Part, StreamClose> = yield* parts

  let pending: Source.Part | undefined
  let closed: StreamClose | null = null

  while (true) {
    const next = yield* subscription.next()

    if (next.done) {
      closed = next.value
      break
    }
    if (next.value.kind === 'file') {
      pending = next.value
      break
    }

    appendField(fields, next.value.name, next.value.value)
  }

  return {
    *[Symbol.iterator]() {
      return {
        *next() {
          if (pending !== undefined) {
            const value = pending
            pending = undefined
            return { done: false as const, value }
          }
          if (closed !== null) {
            return { done: true as const, value: closed }
          }
          return yield* subscription.next()
        },
      }
    },
  }
}
