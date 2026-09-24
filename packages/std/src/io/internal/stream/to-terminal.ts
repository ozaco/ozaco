import type { Flow, Operation } from 'std:effect'
import { until } from 'std:effect'
import { isFailure } from 'std:result'

import type { IODef } from '../../types/io'
import { decodeText } from '../../utils/decode-text'

/** Drain `source`, handing each item to `write`; a failure close is raised once drained. */
function* drain<T>(source: Flow<T, unknown>, write: (item: T) => Operation<void>) {
  const subscription = yield* source

  while (true) {
    const item = yield* subscription.next()

    if (item.done) {
      if (isFailure(item.value)) {
        return yield* item.value
      }
      return
    }

    yield* write(item.value)
  }
}

/**
 * `toTerminal` on Bun/Node: the raw bytes go to `process.stdout` / `process.stderr` untouched (no
 * decoding needed — the terminal reassembles split characters), each write awaited so a slow
 * terminal paces the source.
 */
export function* processToTerminal(
  source: Flow<Uint8Array, unknown>,
  options?: IODef.TerminalOptions,
): Operation<void> {
  const target = options?.stream === 'stderr' ? process.stderr : process.stdout

  yield* drain(source, function* (chunk) {
    yield* until(
      new Promise<void>((resolve, reject) => {
        target.write(chunk, error => (error ? reject(error) : resolve()))
      }),
    )
  })
}

/**
 * `toTerminal` on WebIO: no byte stream to write to, so the bytes are decoded (streaming — split
 * characters survive) and whole LINES go to `console.log` / `console.error`; a trailing partial
 * line is flushed when the source ends.
 */
export function* consoleToTerminal(
  source: Flow<Uint8Array, unknown>,
  options?: IODef.TerminalOptions,
): Operation<void> {
  const log = options?.stream === 'stderr' ? console.error : console.log
  let pending = ''

  try {
    yield* drain(decodeText(source), function* (text) {
      const lines = `${pending}${text}`.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        log(line)
      }
    })
  } finally {
    if (pending) {
      log(pending)
    }
  }
}
