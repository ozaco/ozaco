import { all, operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Helpers, Service } from 'server:core'

import type { CompiledEntry } from '../types'

const isAllowed = (
  meta: { allow?: AnyType[]; deny?: AnyType[]; isRaw?: boolean },
  transformer: unknown,
) =>
  !meta.isRaw &&
  !(meta.allow && !meta.allow.includes(transformer)) &&
  !(meta.deny && meta.deny.includes(transformer))

export const compileEntries = operation(function* (services: Service[], transformer: unknown) {
  const out: CompiledEntry[] = []

  for (const service of services) {
    for (const key of service.getKeys()) {
      const meta = service.getMeta(key)

      if (!meta || !isAllowed(meta, transformer)) {
        continue
      }

      const settings = yield* all(meta.settings ?? [])

      const rest = settings.find((s: AnyType) => s?.transformer === transformer) as
        | Helpers.RestTransformerOptions
        | undefined

      if (!rest) {
        continue
      }

      out.push({
        service: service.name,
        key,
        method: rest.method,
        path: `/${service.name}${rest.path === '/' ? '' : rest.path}`,
        meta: meta as Helpers.ActionMeta<AnyType>,
      })
    }
  }

  return out
})
