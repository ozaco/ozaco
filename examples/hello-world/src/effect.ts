import { operation, race, run, sleep, spawn } from 'std:effect'
import { fail } from 'std:result'
import { filter, pipe } from 'std:shared'

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

const sleepAndReturn = operation(function* <T>(value: T, ms: number) {
  yield* sleep(ms)

  if (ms > 100) {
    yield* fail('too-much')
  }

  return value
})

const result2 = await run(function* () {
  const allUers = yield* race([sleepAndReturn('alice', 100), sleepAndReturn('asuna', 75)])

  const filtered = pipe(
    allUers,
    filter(value => value.includes('')),
  )

  return filtered
})

console.log(result2, 'here')
