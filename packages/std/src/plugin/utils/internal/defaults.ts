import type { Hookable } from '../../types/hookable'

export const createDefaultHooks = (): Hookable.HookStore => ({
  around: [],
  before: [],
  after: [],
  error: [],
  self: [],
})
