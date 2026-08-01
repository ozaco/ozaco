import { operation, until, useAbortSignal } from 'std:effect'
import { asFailure, fail } from 'std:result'

import { fetchImpl } from '../context'
import { createFetchResponse } from '../internal/response'
import type { FetchDef } from '../types'

export const fetch = (
  input: RequestInfo | URL,
  init?: FetchDef.Init | undefined,
  shouldExpect = false,
): FetchDef.Operation => {
  const runFetch = operation(function* () {
    const { timeoutMs, ...rest } = init ?? {}

    try {
      const impl = yield* fetchImpl.get()
      const scopeSignal = yield* useAbortSignal()
      const signal =
        timeoutMs === undefined
          ? scopeSignal
          : AbortSignal.any([scopeSignal, AbortSignal.timeout(timeoutMs)])
      const response = yield* until(impl!(input, { ...rest, signal }))
      const wrapped = createFetchResponse(response)
      if (shouldExpect && !response.ok) {
        return yield* fail(
          'http-status',
          `${response.url}: ${response.status} ${response.statusText}`,
        )
      }
      return wrapped
    } catch (error) {
      // `until` reifies a rejection into a Failure, so unwrap one level; matched by NAME, not
      // `instanceof DOMException` — runtimes disagree on the constructor
      const raw = (error as { error?: unknown } | null)?.error ?? error
      if (timeoutMs !== undefined && (raw as { name?: string } | null)?.name === 'TimeoutError') {
        return yield* fail('timeout', `${input}: timed out after ${timeoutMs}ms`)
      }
      return yield* asFailure(error)
    }
  }, 'fetch')

  const base = runFetch()

  const json = operation(function* <T>() {
    const response = yield* runFetch()
    return yield* response.json<T>()
  }, 'json')

  const text = operation(function* () {
    const response = yield* runFetch()
    return yield* response.text()
  }, 'text')

  const arrayBuffer = operation(function* () {
    const response = yield* runFetch()
    return yield* response.arrayBuffer()
  }, 'array-buffer')

  const blob = operation(function* () {
    const response = yield* runFetch()
    return yield* response.blob()
  }, 'blob')

  const formData = operation(function* () {
    const response = yield* runFetch()
    return yield* response.formData()
  }, 'form-data')

  const bytes = operation(function* () {
    const response = yield* runFetch()
    return yield* response.bytes()
  }, 'bytes')

  const body = operation(function* <T>() {
    const response = yield* runFetch()
    return yield* response.body<T>()
  }, 'body')

  const stream = operation(function* <T>() {
    const response = yield* runFetch()
    return yield* response.stream<T>()
  }, 'stream')

  const raw = operation(function* () {
    const response = yield* runFetch()
    return yield* response.raw()
  }, 'raw')

  return Object.assign(base, {
    json: <T = unknown>() => json<T>(),
    text,
    arrayBuffer,
    blob,
    formData,
    bytes,
    body: <T = unknown>() => body<T>(),
    stream: <T = unknown>() => stream<T>(),
    raw,
    expect: () => fetch(input, init, true),
  })
}
