import type { Result, ResultAsync } from 'std:result'
import type { MaybePromise } from 'std:shared'

import type { SIGNAL } from './const'
import type { SIGNAL_ERRORS } from './errors'

export type SignalListener<Payload> = (payload: Payload) => MaybePromise<void>
export type SignalListenerFn<Payload> = (payload: Payload) => ResultAsync<void, string> | Result<void, string>

export type SignalSubscription = {
  readonly tag: string
  readonly unsubscribe: () => Result<void, SIGNAL_ERRORS.ERR_SIGNAL_UNSUBSCRIBE>
}

export type Signal<Payload = unknown> = {
  readonly _t: typeof SIGNAL
  readonly _i: symbol

  readonly subscribe: (
    listener: SignalListener<Payload>,
    name?: string,
  ) => Result<SignalSubscription, SIGNAL_ERRORS.ERR_SIGNAL_SUBSCRIBE>
  readonly emit: (payload: Payload) => Result<void, SIGNAL_ERRORS.ERR_SIGNAL_EMIT>
  readonly emitAsync: (payload: Payload) => ResultAsync<void, SIGNAL_ERRORS.ERR_SIGNAL_EMIT_ASYNC>
  readonly clear: () => void
  readonly size: () => number
}
