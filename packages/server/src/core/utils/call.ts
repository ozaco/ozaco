import { operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { Transport } from '../definitions'
import { ActionContextRef } from '../internal/contexts'
import type { Action, ActionContext } from '../types/action'

export const useCall = operation(function* <TReturn, TError>(
  action: Action<[ActionContext<AnyType>], TReturn, TError>,
  body: unknown,
) {
  const ambient = yield* ActionContextRef.get()
  return yield* Transport.actions.call(action, body, ambient ?? undefined)
})
