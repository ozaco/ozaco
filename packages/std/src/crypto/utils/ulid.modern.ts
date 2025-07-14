import { $safe, err, fromThrowable } from '../../results'

import { cryptoTags } from '../tag'
import { ENCODING, encodeTime } from './ulid.shared'

const encodeRandom = fromThrowable(
  (length = 16) => {
    const buffer = new Uint8Array(length)
    crypto.getRandomValues(buffer)

    let value = ''

    for (let i = 0; i < length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: Redundant
      value += ENCODING[buffer[i]! % 32]
    }

    return value
  },
  e =>
    err(cryptoTags.get('ulid-random'), 'failed to encode random').appendCause(cryptoTags.get('modern')).appendData(e),
)

export const $ulid = $safe(
  function* (date: Date = new Date()) {
    const time = date.getTime()
    return `${yield* encodeTime(time)}${yield* encodeRandom(16)}`
  },
  cryptoTags.get('ulid'),
  cryptoTags.get('modern'),
) satisfies Std.Crypto.Api['ulid']

export { $parseUlid } from './ulid.shared'
