import type { Action, Service } from 'server:core'
import { all, operation, useContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import { isNatsSetting } from '../internal/is'

import { NatsTransportImpl } from './impl'

export const unmountAction = operation(function* (service: Service) {
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

    // Nested keys (e.g. 'admin.users.list') resolve via proxy + flatten in std:plugin.
    const action = (service.actions as AnyType)[key] as Action
    const subject = (action as Action & { _subject?: string })._subject

    if (typeof subject !== 'string') {
      continue
    }

    const entry = ctx.subjects.get(subject)
    if (!entry) {
      continue
    }

    const sub = ctx.subscriptions.get(subject)
    if (sub) {
      sub.unsubscribe()
      ctx.subscriptions.delete(subject)
    }

    ctx.subjects.delete(subject)
    delete (action as Action & { _subject?: string })._subject
  }
})
