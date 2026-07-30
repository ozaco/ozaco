import type { Action, GatewayDef, Service } from 'server:core'
import { all, operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { DocsDef } from '../types'

/**
 * Exposure is a consequence of a declaration the author already wrote: an action is documented iff
 * it carries a setting belonging to this transformer.
 *
 * There is no `isPrivate`/`allow`/`deny` triple any more, and removing it removed a whole class of
 * disagreement — three flags could say an action was exposed while it carried no setting to expose
 * it with, or the reverse. The settings filter below is now the only gate.
 */
export const compileEntries = operation(function* (
  services: Service[],
  transformer: unknown,
  prefixes?: ReadonlyMap<unknown, string>,
) {
  const out: DocsDef.CompiledEntry[] = []

  for (const service of services) {
    // the REAL mount prefix when the gateway knows it; the name-shaped guess otherwise
    const prefix = prefixes?.get(service) ?? `/${service.name}`

    for (const [key, action] of yield* service.actions._list()) {
      const settings = yield* all(action.settings ?? [])

      const rest = settings.find((s: AnyType) => s?.transformer === transformer) as
        | GatewayDef.RestOptions
        | undefined

      if (!rest) {
        continue
      }

      out.push({
        service: service.name,
        key,
        method: rest.method,
        path: `${prefix}${rest.path === '/' ? '' : rest.path}` || '/',
        rest,
        meta: action as Action.Meta<AnyType>,
      })
    }
  }

  return out
})
