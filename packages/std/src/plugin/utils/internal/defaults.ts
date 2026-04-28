import type { Helpers } from '../../types/helpers'

export const createDefaultHooks = (): Helpers.HookStore => ({
  around: [],
  before: [],
  after: [],
  error: [],
  self: [],
})
