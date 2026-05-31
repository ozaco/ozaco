import { Gateway } from 'server:core'
import { operation, useContext } from 'std:effect'

// listener state lives on the gateway context; these actions are platform-agnostic
export const isStartedAction = operation(function* () {
  return (yield* useContext(Gateway.context)).started
})

export const pauseAction = operation(function* (cause: string) {
  const ctx = yield* useContext(Gateway.context)
  ctx.paused = cause
})

export const isPausedAction = operation(function* () {
  return (yield* useContext(Gateway.context)).paused
})

export const resumeAction = operation(function* () {
  const ctx = yield* useContext(Gateway.context)
  ctx.paused = false
})
