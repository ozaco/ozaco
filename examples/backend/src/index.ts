import { main, suspend } from 'std:effect'

await main(function* () {
  yield* suspend()
})
