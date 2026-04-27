import type { Action, Service } from 'server:core'
import { isAction } from 'server:core'
import type { AnyType } from 'std:shared'

export const resolveActionHandler = (target: Action | Service, key?: string): Action => {
  if (isAction(target)) {
    return target
  }

  let handler: AnyType = (target as AnyType).actions
  for (const part of (key ?? '').split('.')) {
    handler = handler[part]
  }

  return handler as Action
}
