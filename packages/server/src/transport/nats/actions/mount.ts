import type { Action, Service } from 'server:core'
import { all, operation, useContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import { isNatsSetting } from '../internal/is'

import { NatsTransportImpl } from './impl'

export const mountAction = operation(function* (service: Service) {
  const ctx = yield* useContext(NatsTransportImpl.context)

  for (const key of service.getKeys()) {
    const meta = service.getMeta(key)
    if (!meta) {
      continue
    }

    const settings = (yield* all(meta.settings ?? [])).filter(isNatsSetting)

    if (settings.length === 0) {
      continue
    }

    const setting = settings[0]!
    // Nested keys (e.g. 'admin.users.list') resolve via proxy + flatten in std:plugin.
    const action = (service.actions as AnyType)[key] as Action
    const subject = setting.subject ?? `${service.name}@${service.version}#${key}`

    if (ctx.subjects.has(subject)) {
      continue
    }

    const entry = { service, key, action, subject, queueGroup: setting.queueGroup }

    ctx.subjects.set(subject, entry)
  }
})
