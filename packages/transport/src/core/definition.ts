import type { Operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'

import { TRANSPORT } from './const'
import type { TransportDef } from './types/transport'

/**
 * The messaging protocol: topic-addressed data / event / flow / stream / package planes over any
 * backend (`transport:impl/{memory,nats,redis}`). Cloneable — several backends may be installed
 * side by side; routed `Transport.actions.*` hit the most recently installed one, a pinned
 * handle (`NatsTransport.actions.*`) always its own. Every impl is a thin driver; the planes are
 * assembled in core by `transportActions`, so middleware (`Transport.around({ publish })`)
 * wraps the same code path for every backend.
 */
export const Transport = defineProtocol<TransportDef.Options, TransportDef.Actions>({
  name: 'transport',
  version: '0.2.0',
  description: 'Topic-addressed messaging: data, event, flow, stream and package planes',

  cloneable: true,
  subtype: TRANSPORT,

  defaults: {
    *describe(): Operation<TransportDef.Options> {
      return yield* Transport.context.expect()
    },
  },
})
