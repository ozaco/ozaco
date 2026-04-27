import { until } from 'std:effect'

import { connect } from '@nats-io/transport-node'
import { Transport } from 'server:core'

import type { NatsTransportContext, NatsTransportOptions } from '../types'

export const NatsTransportImpl = Transport.implement<
  NatsTransportContext,
  unknown,
  [options: NatsTransportOptions]
>({
  name: 'plugin:transport:nats',
  version: '0.0.1',

  *setup(options) {
    const nc = yield* until(
      connect({
        servers: options.servers,
      }),
    )

    return {
      options,
      nc,
      byAction: new Map(),
      bySubject: new Map(),
      subscriptions: new Map(),
      abort: new AbortController(),
      isStarted: false,
      isPaused: false,
    } satisfies NatsTransportContext
  },
})
