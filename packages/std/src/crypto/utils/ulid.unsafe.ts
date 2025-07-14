import { $safe, err, fromThrowable } from '../../results'

import { cryptoTags } from '../tag'
import { ENCODING, encodeTime } from './ulid.shared'

const encodeRandom = fromThrowable(
  (length = 16) => {
    let value = ''

    for (let i = 0; i < length; i++) {
      const randomIndex = Math.floor(Math.random() * 32)
      value += ENCODING[randomIndex]
    }

    return value
  },
  e =>
    err(cryptoTags.get('ulid-random'), 'failed to encode random').appendCause(cryptoTags.get('unsafe')).appendData(e),
)

export const $ulid = $safe(
  function* (date: Date = new Date()) {
    const time = date.getTime()
    return `${yield* encodeTime(time)}${yield* encodeRandom(16)}`
  },
  cryptoTags.get('ulid'),
  cryptoTags.get('unsafe'),
) satisfies Std.Crypto.Api['ulid']

export { $parseUlid } from './ulid.shared'
