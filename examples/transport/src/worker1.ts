import { Router, Server, Transport } from 'server:core'
import { main, suspend } from 'std:effect'
import { install } from 'std:plugin'

import { BunServer } from 'server:impl/bun'
import { DefaultRouter } from 'server:plugin/router'
import { NatsTransport } from 'server:transport/nats'
import { BunIO } from 'std:io/impl/bun'

import { GreetingService } from './greeting.service'

await main(function* () {
  yield* install(BunIO)
  yield* install(BunServer)
  yield* install(DefaultRouter)
  yield* install(NatsTransport, {
    servers: ['nats://127.0.0.1:4222'],
  })

  yield* install(GreetingService)
  yield* Router.actions.mount('', GreetingService)

  yield* Transport.actions.start()

  const { host, port } = yield* Server.actions.start({
    port: 3000,
    host: '0.0.0.0',
  })

  console.log(`Server is listening: http://${host}:${port}/`)

  yield* suspend()
})
