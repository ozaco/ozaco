import { main, suspend } from 'std:effect'
import { install } from 'std:plugin'

import { BunServer } from 'server:bun'
import { DefaultRouter, Server } from 'server:core'

import { TodoService } from './todo.service'

await main(function* () {
  yield* install(BunServer)
  yield* install(DefaultRouter)
  yield* install(TodoService)

  try {
    yield* TodoService.actions.add({
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
