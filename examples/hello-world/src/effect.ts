import { each, run, spawn } from 'std:effect'
import { createEvent, useEvent, useEventOnce } from 'std:event'

const bus = createEvent<{
  data: [string, number]
  error: [Error]
  close: []
}>()

await run(function* () {
  const onDataStream = useEvent(bus, 'data')

  yield* spawn(function* () {
    for (const data of yield* each(onDataStream)) {
      console.log(data, 'here')
    }
  })

  bus.emit('data', 'sa', 10)
  bus.emit('data', 'sa', 10)

  const a = yield* useEventOnce(bus, 'close')
})
