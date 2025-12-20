import type { EventEmitter } from 'std:event'

import type { CONTEXT } from '../const'

import type { Helpers } from './helpers'

export type ContextEvents = {
  extendable: Helpers.AnyExtendable
}

export type Context<Data> = {
  _t: typeof CONTEXT

  event: EventEmitter<ContextEvents>

  getBinding: (from: Helpers.AnyExtendable) => Data | undefined
  bind: (to: Helpers.AnyExtendable, override?: boolean) => Data
}
