import { CoreErrors, defineAction, defineService, isService } from 'server:core'

import { describe, expect, it } from 'bun:test'

import { catchFailure } from '../helpers'

const noop = defineAction(function* () {
  return null
})

describe('defineService', () => {
  it('brands and defaults', () => {
    const service = defineService({ name: 'todos', actions: { noop } })

    expect(isService(service)).toBe(true)
    expect(service.version).toBe('0.0.0')
    expect(service.events).toEqual({})
    expect(service.actions.noop).toBe(noop)
  })

  it('rejects an empty name and non-action members', () => {
    const unnamed = catchFailure(() => defineService({ name: '', actions: {} }))
    expect(unnamed.error).toBe(CoreErrors.Configuration)
    expect(unnamed.message).toBe('a service requires a non-empty name')

    const broken = catchFailure(() =>
      defineService({ name: 'x', actions: { broken: (() => null) as never } }),
    )
    expect(broken.error).toBe(CoreErrors.Configuration)
    expect(broken.message).toBe('service "x" action "broken" is not a defineAction result')
  })
})
