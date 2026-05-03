import { operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { Transport } from '../definitions'
import { ActionRequestContext } from '../internal/contexts'
import type { Action } from '../types/action'

export const useCall = operation(function* <TReturn, TError>(
  action: Action<[AnyType], TReturn, TError>,
  body: unknown,
) {
  const ambient = yield* ActionRequestContext.get()
  return yield* Transport.actions.call(action, body, ambient ?? undefined)
})
