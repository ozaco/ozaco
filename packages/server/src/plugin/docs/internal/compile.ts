import type { Action, GatewayDef, Service } from 'server:core'
import { all, operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { DocsDef } from '../types'

const isAllowed = (
  meta: { allow?: AnyType[]; deny?: AnyType[]; isPrivate?: boolean },
  transformer: unknown,
) =>
  // current-branch Action.Meta uses isPrivate (not the old isRaw) and defaults allow/deny to [] (not
  // undefined), so guard on length — an empty allow list must NOT exclude the action
  !meta.isPrivate &&
  !(meta.allow?.length && !meta.allow.includes(transformer)) &&
  !(meta.deny?.length && meta.deny.includes(transformer))

export const compileEntries = operation(function* (services: Service[], transformer: unknown) {
  const out: DocsDef.CompiledEntry[] = []

  for (const service of services) {
    for (const key of service.getKeys()) {
      const meta = service.getMeta(key)

      if (!meta || !isAllowed(meta, transformer)) {
        continue
      }

      const settings = yield* all(meta.settings ?? [])

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
        path: `/${service.name}${rest.path === '/' ? '' : rest.path}`,
        rest,
        meta: meta as Action.Meta<AnyType>,
      })
    }
  }

  return out
})
