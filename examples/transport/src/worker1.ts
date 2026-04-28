import { Router, Server, Transport } from 'server:core'
import { main, suspend } from 'std:effect'
import { DefaultLogger, Logger } from 'std:logger'
import { install } from 'std:plugin'
import { fail } from 'std:result'

import { BunServer } from 'server:impl/bun'
import { DefaultRouter } from 'server:plugin/router'
import { NatsTransport } from 'server:transport/nats'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'
import { FileTransport } from 'std:logger/transport/file'

import { GreetingService } from './greeting.service'

await main(function* () {
  yield* install(DefaultLogger)
  yield* install(ConsoleTransport)

  yield* install(BunIO)
  yield* install(FileTransport, {
    path: '.ozaco/logs/transport.log',
  })

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

  yield* Logger.actions.debug('server started', { host, port })

  yield* Logger.actions.child({ reqId: '123' }, function* () {
    yield* Logger.actions.warn(fail('slow-query', 'this is a warning', 'cause1', 'cause2'))
  })

  yield* suspend()
})
