import { run, sleep, spawn } from 'std:effect'
import { createEvent, onEvent, useEventOnce } from 'std:event'

const bus = createEvent<{
  data: [string, number]
  error: [Error]
  close: []
}>()

run(function* () {
  yield* spawn(function* () {
    yield* onEvent(bus, 'data', function* (name, age) {
      console.log(name, age, 'here')
    })
  })

  yield* sleep(0)
  bus.emit('data', 'alice', 19)
  bus.emit('data', 'yuuki', 15)

  yield* useEventOnce(bus, 'close')
})

setTimeout(() => {
  bus.emit('close')
}, 1000)
