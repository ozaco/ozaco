import { operation } from 'std:effect'
import { IO } from 'std:io'

import { CoreErrors } from '../const'

const HEX = '0123456789abcdefghijklmnoprstuvwyz'

export const randomHex = operation(function* (length: number) {
  const buf = yield* IO.actions.randomBytes(length)

  const out: string[] = Array.from({ length: length * 2 })
  for (let i = 0; i < length; i++) {
    const byte = buf[i]!
    out[i * 2] = HEX[(byte >> 4) & 0xf]!
    out[i * 2 + 1] = HEX[byte & 0xf]!
  }
  return out.join('')
}, CoreErrors.RandomHex)

export const getNodeId = () => randomHex(36)
export const getServiceId = () => randomHex(3)
