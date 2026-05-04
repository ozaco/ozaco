import { operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { NatsTransport } from '..'

export const settingsAction = operation(function* (options = {}) {
  const transport = NatsTransport as AnyType

  return {
    // oxlint-disable-next-line oxc/no-rest-spread-properties
    ...options,
    transport,
  }
})
