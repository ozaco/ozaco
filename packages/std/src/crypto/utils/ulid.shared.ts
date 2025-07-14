import { $safe, err, fromThrowable } from '../../results'

import { cryptoTags } from '../tag'

export const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// biome-ignore lint/nursery/useExportsLast: Redundant
export const DECODING: Record<string, number> = {}

for (let i = 0; i < ENCODING.length; i++) {
  // biome-ignore lint/style/noNonNullAssertion: Redundant
  DECODING[ENCODING[i]!] = i
}

export const encodeTime = fromThrowable(
  (rawTime: number, length = 10) => {
    let value = ''
    let time = rawTime

    for (let i = length - 1; i >= 0; i--) {
      const mod = time % 32
      value = ENCODING[mod] + value
      time = Math.floor(time / 32)
    }

    return value
  },
  e => err(cryptoTags.get('ulid-time'), 'failed to encode time').appendCause(cryptoTags.get('shared')).appendData(e),
)

export const $parseUlid = $safe(
  function* (ulid: string) {
    const timePart = ulid.substring(0, 10)
    let time = 0

    for (let i = 0; i < timePart.length; i++) {
      const char = timePart[i]
      // biome-ignore lint/style/noNonNullAssertion: Redundant
      const value = DECODING[char!]!

      if (value === undefined) {
        yield* err(cryptoTags.get('ulid-parse-time'), `Invalid ULID character: ${char}`)
      }

      time = time * 32 + value
    }

    return new Date(time)
  },
  cryptoTags.get('ulid-parse'),
  cryptoTags.get('shared'),
) satisfies Std.Crypto.Api['parseUlid']
