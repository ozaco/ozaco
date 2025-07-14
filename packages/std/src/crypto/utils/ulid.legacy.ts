import { randomBytes } from 'node:crypto'

import { $safe, err, fromThrowable } from '../../results'

import { cryptoTags } from '../tag'
import { ENCODING, encodeTime } from './ulid.shared'

const encodeRandom = fromThrowable(
  (length = 16) => {
    const buffer = randomBytes(length)

    let value = ''

    for (let i = 0; i < length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: Redundant
      value += ENCODING[buffer[i]! % 32]
    }

    return value
  },
  e =>
    err(cryptoTags.get('ulid-random'), 'failed to encode random').appendCause(cryptoTags.get('legacy')).appendData(e),
)

export const $ulid = $safe(
  function* (date: Date = new Date()) {
    const time = date.getTime()
    return `${yield* encodeTime(time)}${yield* encodeRandom(16)}`
  },
  cryptoTags.get('ulid'),
  cryptoTags.get('legacy'),
) satisfies Std.Crypto.Api['ulid']

export { $parseUlid } from './ulid.shared'
