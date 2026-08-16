import { Broker, DefaultBroker } from 'server:core'
import type { BrokerOptions } from 'server:core'
import { operation } from 'std:effect'
import { DefaultLogger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'
import type { Result } from 'std:result'

import { BunIO } from 'std:io/impl/bun'

/** IO + silent logger + broker, started — the standard core test bed. */
export const bootstrap = operation(function* (options?: BrokerOptions) {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.silent })
  yield* install(DefaultBroker, options)
  yield* Broker.actions.start()
})

/** Extracts the `cid:<id>` breadcrumb a fulfillment failure carries in its causes. */
export const cidOf = (failure: Result.Failure<unknown>): string => {
  for (const cause of failure.causes) {
    const match = /cid:(\S+)/u.exec(cause)

    if (match?.[1]) {
      return match[1]
    }
  }

  throw new Error(`no cid breadcrumb in causes: ${failure.causes.join(' | ')}`)
}
