import { fail } from 'std:result'

import { DbErrors } from '../errors'
import type { Adapter } from '../types/adapter'

/**
 * Typed fallbacks for the contract members an adapter does not have to write itself — spread
 * them into `build({...})` and override only what the backend actually supports:
 * `DbAdapter.implement({...}).build({ ...adapterDefaults('x'), find, … })`.
 */
export const adapterDefaults = (adapter: string): Adapter.Defaults => ({
  *transaction() {
    return yield* fail(
      DbErrors.Unsupported,
      `the "${adapter}" adapter does not support transactions`,
    )
  },
  *raw() {
    return yield* fail(
      DbErrors.Unsupported,
      `the "${adapter}" adapter does not support raw statements`,
    )
  },
})
