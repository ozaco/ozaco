import { all, operation, useContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Action, Service } from 'server:core'

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

    // TODO: nested keys
    const action = (service.actions as AnyType)[key] as Action

    const entry = ctx.byAction.get(action)
    if (!entry) {
      continue
    }

    const sub = ctx.subscriptions.get(entry.subject)
    if (sub) {
      sub.unsubscribe()
      ctx.subscriptions.delete(entry.subject)
    }

    ctx.byAction.delete(action)
    ctx.bySubject.delete(entry.subject)
    delete (action as Action & { _subject?: string })._subject
  }
})
