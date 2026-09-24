import type { Flow } from 'std:effect'
import { flowOf } from 'std:effect'

/**
 * Decode a byte flow into text chunks with ONE streaming `TextDecoder`, so a multi-byte character
 * split across two chunks decodes whole (a per-chunk `decode()` would emit U+FFFD halves). Empty
 * decodes are skipped; the decoder's tail is flushed when the source ends, and the flow closes with
 * the source's own close value (a failure close included). `label` is any WHATWG encoding label
 * (default UTF-8).
 */
export const decodeText = <TClose>(
  source: Flow<Uint8Array, TClose>,
  label = 'utf8',
): Flow<string, TClose> =>
  flowOf<string, TClose>(function* (emit) {
    const decoder = new TextDecoder(label)
    const subscription = yield* source

    while (true) {
      const item = yield* subscription.next()

      if (item.done) {
        const tail = decoder.decode()
        if (tail) {
          yield* emit(tail)
        }
        return item.value
      }

      const text = decoder.decode(item.value, { stream: true })
      if (text) {
        yield* emit(text)
      }
    }
  })
