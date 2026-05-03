import { createContext } from 'std:effect'

import type { ActionRequest, ActionResponse } from '../types/action'
import type { Service } from '../types/service'

export const SelfContext = createContext<Service>('server:service:self')

export const ActionRequestContext = createContext<ActionRequest>('server:action:request')
export const ActionResponseContext = createContext<ActionResponse>('server:action:response')
export const ActionRawRequestContext = createContext<unknown>('server:action:raw-request')
export const ActionRawResponseContext = createContext<unknown>('server:action:raw-response')
