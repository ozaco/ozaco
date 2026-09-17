import type { Operation } from 'std:effect'
import { IO, IO_FLAGS } from 'std:io'

import type { FileDef } from './types'

export const encoder = new TextEncoder()

/** Append every buffered record to the file in one write. */
export function* drain(ctx: FileDef.Context): Operation<void> {
  if (ctx.buffer.length === 0) {
    return
  }

  const payload = ctx.buffer.join('')
  ctx.buffer.length = 0

  yield* IO.actions.write(ctx.options.path, encoder.encode(payload), { flags: IO_FLAGS.append })
}
