import type { Stream } from '../types/operation'

import { resource } from './resource'
import { createSignal } from './signal'
import { spawn } from './spawn'

export const debounce = <T>(source: Stream<T, unknown>, ms: number): Stream<T, never> =>
  resource(function* (provide) {
    const output = createSignal<T, never>()
    let timerId: ReturnType<typeof setTimeout> | undefined
    let pending: { value: T } | undefined

    // declared outside the loop (no closure-over-loop-var); emits the latest buffered value once
    const fire = () => {
      if (pending !== undefined) {
        output.send(pending.value)
        pending = undefined
      }
    }

    // `provide` suspends this resource until teardown, so the source is consumed from a background
    // task — after `provide` the loop would never run.
    yield* spawn(function* () {
      const subscription = yield* source

      let done = false
      while (!done) {
        const next = yield* subscription.next()
        if (next.done) {
          done = true
        } else {
          if (timerId !== undefined) {
            clearTimeout(timerId)
          }
          pending = { value: next.value }
          timerId = setTimeout(fire, ms)
        }
      }

      // flush the trailing value if the source completed inside the debounce window
      if (timerId !== undefined) {
        clearTimeout(timerId)
      }
      fire()
      output.close(undefined as never)
    })

    yield* provide(yield* output)
  })
