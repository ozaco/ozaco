import type { AnyType } from 'std:shared'

import { SERVICE } from '../const'
import type { ServerDef } from '../types/server'

/** One parsed `call(...)`: the target coordinates plus the (input, options) tail. */
export interface ParsedCall {
  readonly service: string
  readonly action: string
  readonly input: unknown
  readonly options: ServerDef.CallOptions | undefined
}

/**
 * The ONE place both `call` spellings are told apart — a service DEFINITION plus an action name
 * (`call(reports, 'summary', input)`), or a typed REF with the args shifted along
 * (`call(api.reports.summary, input)`). `null` when the target is neither.
 */
export const parseCall = (target: AnyType, rest: readonly AnyType[]): ParsedCall | null => {
  if (target?._t === SERVICE && typeof rest[0] === 'string') {
    return {
      service: target.name as string,
      action: rest[0],
      input: rest[1],
      options: rest[2] as ServerDef.CallOptions | undefined,
    }
  }

  if (typeof target?.service === 'string' && typeof target?.action === 'string') {
    return {
      service: target.service,
      action: target.action,
      input: rest[0],
      options: rest[1] as ServerDef.CallOptions | undefined,
    }
  }

  return null
}
