import { Transport } from 'server:core'
import { main, suspend } from 'std:effect'
import { install } from 'std:plugin'

import { NatsTransport } from 'server:transport/nats'

import { MathService } from './math.service'

await main(function* () {
  yield* install(NatsTransport, {
    servers: ['nats://127.0.0.1:4222'],
  })

  yield* install(MathService)

  yield* Transport.actions.start()

  yield* suspend()
})
