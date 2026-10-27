import type { Operation } from 'std:effect'
import { recover } from 'std:effect'
import { IO, IO_FLAGS } from 'std:io'

import type { FileDef } from './types'

const encoder = new TextEncoder()

/** `<path>.<keep-1>` → `<path>.<keep>` … `<path>.1` → `<path>.2`, then `<path>` → `<path>.1` (a
 * step whose file is not there is skipped). */
function* shift(path: string, keep: number): Operation<void> {
  for (let index = Math.max(1, keep) - 1; index >= 1; index -= 1) {
    yield* recover(() => IO.actions.rename(`${path}.${index}`, `${path}.${index + 1}`))
  }

  yield* IO.actions.rename(path, `${path}.1`)
}

/** Append every buffered record to the file in one write — rotating first when that write would
 * take the file past `rotate.maxBytes` (the fresh file gets `mode` again). */
export function* drain(ctx: FileDef.Context): Operation<void> {
  if (ctx.buffer.length === 0) {
    return
  }

  const payload = encoder.encode(ctx.buffer.join(''))
  const { path, mode, rotate } = ctx.options

  ctx.buffer.length = 0

  if (rotate && ctx.size > 0 && ctx.size + payload.byteLength > rotate.maxBytes) {
    yield* shift(path, rotate.keep ?? 1)
    yield* IO.actions.ensureFile(path)

    if (mode !== undefined) {
      yield* IO.actions.chmod(path, mode)
    }

    ctx.size = 0
  }

  yield* IO.actions.write(path, payload, { flags: IO_FLAGS.append })
  ctx.size += payload.byteLength
}
