import { err, fromThrowable } from '../../results'

import { cryptoTags } from '../tag'

export const $uuid = fromThrowable(
  () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, match => {
      // biome-ignore lint/nursery/noBitwiseOperators: Redundant
      const random = (Math.random() * 16) | 0

      // biome-ignore lint/nursery/noBitwiseOperators: Redundant
      const value = match === 'x' ? random : (random & 0x3) | 0x8

      return value.toString(16)
    }) as Std.Crypto.Uuid,
  e => err(cryptoTags.get('uuid'), 'failed to generate uuid').appendCause(cryptoTags.get('unsafe')).appendData(e),
) satisfies Std.Crypto.Api['uuid']
