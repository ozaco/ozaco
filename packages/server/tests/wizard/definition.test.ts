import { installWizard, query, resource, WizardErrors } from 'server:wizard'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { catchFailure, runResult } from '../helpers'

import { tasks } from './helpers'

describe('wizard definition-time validation', () => {
  it('resource rejects members that are not fn declarations', () => {
    const failure = catchFailure(() => resource('ops2', { broken: {} as never }))

    expect(failure.error).toBe(WizardErrors.BadDefinition)
    expect(failure.message).toBe(
      'resource "ops2" fn "broken" is not a query/mutation/action declaration',
    )
  })

  it('table resources reserve the "realtime" fn key', () => {
    const failure = catchFailure(() =>
      resource(tasks, {
        realtime: query({
          *handler() {
            return 1
          },
        }),
      }),
    )

    expect(failure.error).toBe(WizardErrors.BadDefinition)
    expect(failure.message).toBe(
      'resource "tasks" fn key "realtime" is reserved for the SSE realtime action',
    )
  })

  it('installWizard rejects api entries that are neither resources nor services', async () => {
    const outcome = await runResult(() =>
      installWizard({ bogus: {} as never }, { gateway: false, bus: false }),
    )

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe(WizardErrors.BadDefinition)
      expect(outcome.message).toBe('wizard api entry "bogus" is neither a resource nor a service')
    }
  })
})
