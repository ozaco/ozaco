import { Broker, DefaultBroker } from 'server:core'
import { main, suspend } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'

import { BucketPolicy } from 'server:policy/bucket'
import { NatsTransport } from 'server:transport/nats'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'

import { ENV } from './env'
import { runResilienceDemo } from './resilience'
import { runServerDemo } from './server'
import { GreeterService } from './services/greeter'
import { UserService } from './services/user'

await main(function* () {
  yield* install(BunIO)
  // debug level so the per-policy dispatch trace (broker `trace: true`) is visible
  yield* install(DefaultLogger, { level: LogLevel.debug })
  yield* install(ConsoleTransport)

  const env = yield* ENV

  // self-contained resilience showcase (no NATS): `SERVICE=resilient bun run ...`
  if (env.service === 'resilient') {
    yield* runResilienceDemo()
    yield* suspend()
    return
  }

  // self-contained layered HTTP + WebSocket server over the broker (no NATS): `SERVICE=server ...`
  if (env.service === 'server') {
    yield* runServerDemo()
    yield* suspend()
    return
  }

  // distributed services over NATS — run one process per SERVICE (e.g. user + greeter)
  yield* install(DefaultBroker)
  yield* install(NatsTransport)
  yield* install(BucketPolicy)

  yield* install(GreeterService)
  yield* install(UserService)

  yield* Broker.actions.register(env.services[env.service as keyof typeof env.services])

  yield* Broker.actions.start()

  if (env.service === 'user') {
    const response = yield* Broker.actions.call(UserService.actions.greetMany, [
      ['Alice', 'Bob', 'Carol'],
    ])

    yield* Logger.actions.info('result here', ...response)

    // const [response, response2] = yield* all([
    //   Broker.actions.call(UserService.actions.greetMany, [['Alice', 'Bob', 'Carol']]),
    //   Broker.actions.call(UserService.actions.greetMany, [['Kirito']]),
    // ])
    // yield* Logger.actions.info(
    //   'Stream response:',
    //   response.join(', '),
    //   '-----',
    //   response2.join(', '),
    // )
  }

  yield* suspend()
})
