import { main, suspend } from 'std:effect'
import { install } from 'std:plugin'

import { BunServer } from 'server:bun'
import { DefaultRouter, Server } from 'server:core'
import { Docs } from 'server:docs'
import { BunIO } from 'std:io/bun'

import { CustomCorsPlugin } from './cors.plugin'
import { TodoService } from './todo.service'

await main(function* () {
  yield* install(BunIO)
  yield* install(BunServer)
  yield* install(DefaultRouter)
  yield* install(TodoService)
  yield* install(CustomCorsPlugin)

  yield* install(Docs, {
    title: 'Backend API',
    version: '0.0.1',
  })

  yield* Docs.actions.from(TodoService)

  try {
    yield* TodoService.actions.create({
      // @ts-expect-error test validation
      body: 'test',
    })
  } catch {
    console.log('validations working')
  }

  const { host, port } = yield* Server.actions.start({
    port: 3000,
    host: '0.0.0.0',
  })

  console.log(`Server is listening: http://${host}:${port}/`)

  yield* suspend()
})
