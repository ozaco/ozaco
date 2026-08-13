import type { Operation } from 'std:effect'
import { operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DbErrors } from './errors'
import type { AdapterDef } from './types'

/**
 * The database+driver binding protocol. Each backend lives in its own module (`db:impl/{memory,
 * sqlite,pg,bun-sql,…}`) and statically imports ONLY its own driver package. An adapter receives
 * portable operation specs (never SQL text), owns all storage en/decoding + dialect knowledge, and
 * classifies backend errors into `DbErrors` tags. Not cloneable — one backend per scope; install an
 * adapter, then `DbClient`. The capability-gated actions (`transaction`/`raw`/`live`) have failing
 * (resp. `null`) protocol defaults, so an adapter only implements what its backend supports.
 *
 * Middleware belongs here: `DbAdapter.around({ find: … })` wraps every read the `Database` handle
 * performs, exactly where the old interceptor pipeline used to sit.
 */
export const DbAdapter = defineProtocol<AdapterDef.Info, AdapterDef.Actions>({
  name: 'db-adapter',
  version: '0.1.0',
  description: 'Structured database adapter: portable specs in, decoded documents out',
  defaults: {
    transaction: operation(function* () {
      return yield* fail(
        DbErrors.Unsupported,
        'the installed db adapter does not support transactions',
      )
    }) as AnyType,
    raw: operation(function* () {
      return yield* fail(
        DbErrors.Unsupported,
        'the installed db adapter does not support raw statements',
      )
    }) as AnyType,
    live: operation(function* () {
      return null
    }) as AnyType,
  },
})

/** Resolve the installed adapter's info (`{ adapter, capabilities }`); install an adapter first. */
export const useAdapter = (): Operation<AdapterDef.Info> => DbAdapter.context.expect()

/**
 * Typed fallbacks for the capability-gated actions — spread these into `build({...})` and override
 * only what the backend actually supports:
 * `DbAdapter.implement({...}).build({ ...adapterDefaults('x'), find, … })`.
 */
export const adapterDefaults = (
  adapter: string,
): Pick<AdapterDef.Actions, 'transaction' | 'live' | 'raw'> => ({
  transaction: operation(function* () {
    return yield* fail(
      DbErrors.Unsupported,
      `the "${adapter}" adapter does not support transactions`,
    )
  }) as AnyType,
  live: operation(function* () {
    return null
  }),
  raw: operation(function* () {
    return yield* fail(
      DbErrors.Unsupported,
      `the "${adapter}" adapter does not support raw statements`,
    )
  }) as AnyType,
})
