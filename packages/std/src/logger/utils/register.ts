import { operation } from 'std:effect'

import { LoggerTransportRegistryRef } from '../internal/contexts'
import type { Helpers } from '../types/helpers'

export const registerTransport = operation(function* (entry: Helpers.LoggerTransportEntry) {
  const existing = (yield* LoggerTransportRegistryRef.get()) ?? []
  yield* LoggerTransportRegistryRef.set([...existing, entry])
})

export const unregisterTransport = operation(function* (name: string) {
  const existing = (yield* LoggerTransportRegistryRef.get()) ?? []
  yield* LoggerTransportRegistryRef.set(existing.filter(entry => entry.name !== name))
})

export const getTransports = operation(function* () {
  return (yield* LoggerTransportRegistryRef.get()) ?? []
})
