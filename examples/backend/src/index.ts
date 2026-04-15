import { main } from 'std:effect'
import { install } from 'std:plugin'

import { TodoService } from './todo.service'

await main(function* () {
  yield* install(TodoService)

  const result = yield* TodoService.actions.add({
    body: 'sa',
  })

  console.log('hi', result)
})
