import { run, sleep, spawn } from 'std:effect'

const result = await run(function* () {
  // <- parent scope
  yield* spawn(function* () {
    let i = 0

    while (true) {
      yield* sleep(10)

      console.log('got value:', i)
      i++
    }
  })

  yield* sleep(11)

  return 'hey'
})

console.log(result)
