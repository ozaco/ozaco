import { operation } from 'std:effect'
import { fail } from 'std:result'

import { CoreErrors } from '../errors'
import type { PolicyDispatch, PolicyEntry, PolicyNext } from '../types/policy'

import { PolicyRegistryContext } from './context'

export const policyGetHandler = operation(function* () {
  return (yield* PolicyRegistryContext.get()) ?? []
})

export const policyRegisterHandler = operation(function* (entry: PolicyEntry) {
  const existing = yield* policyGetHandler()

  if (existing.some(candidate => candidate.name === entry.name)) {
    return yield* fail(CoreErrors.Configuration, `policy "${entry.name}" is already registered`)
  }

  const next = [...existing, entry].toSorted((a, b) => a.priority - b.priority)

  yield* PolicyRegistryContext.set(next)
})

export const policyUnregisterHandler = operation(function* (name: string) {
  const existing = yield* policyGetHandler()

  yield* PolicyRegistryContext.set(existing.filter(candidate => candidate.name !== name))
})

/**
 * Builds the onion per dispatch — lowest priority outermost. An action-level override of `false`
 * removes the layer; streaming dispatches skip `skipStreaming` layers unless explicitly overridden.
 */
export const policyDispatchRoot = operation(function* (ctx: PolicyDispatch, terminal: PolicyNext) {
  const entries = yield* policyGetHandler()

  let next = terminal

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as PolicyEntry
    const override = ctx.overrides[entry.name]

    if (override === false) {
      continue
    }

    if (entry.skipStreaming && ctx.streaming && override === undefined) {
      continue
    }

    const inner = next

    next = () => entry.apply(ctx, inner)
  }

  return yield* next()
})
