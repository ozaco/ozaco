import { all, operation, useContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Action, Service } from 'server:core'

import { isNatsSetting } from '../internal/is'

import { NatsTransportImpl } from './impl'

export const mountAction = operation(function* (service: Service) {
  const ctx = yield* useContext(NatsTransportImpl.context)
  const prefix = ctx.options.prefix ? `${ctx.options.prefix}.` : ''

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
    // TODO: nested keys
    const action = (service.actions as AnyType)[key] as Action
    const subject = setting.subject ?? `${prefix}${service.name}.${key}`

    if (ctx.bySubject.has(subject)) {
      continue
    }

    const entry = { service, key, action, subject, queueGroup: setting.queueGroup }
    ctx.byAction.set(action, entry)
    ctx.bySubject.set(subject, entry)
    ;(action as Action & { _subject?: string })._subject = subject
  }
})
