import { isPlugin } from 'std:plugin'

import { extendableTransport } from './create-transport'

import { extendable as extendableLogger } from './plugin/extendable'

import type { AnyTransport, LoggerPlugin } from './type'

export const isLogger = (value: unknown): value is LoggerPlugin => {
  return isPlugin(value) && value._e === extendableLogger
}

export const isTransport = (value: unknown): value is AnyTransport => {
  return isPlugin(value) && value._e === extendableTransport
}
