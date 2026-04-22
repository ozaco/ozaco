import { operation, until, useAbortSignal } from 'std:effect'
import { asFailure, fail } from 'std:result'

import { errorMessage, isAbortError } from '../internal/common'
import { createFetchResponse } from '../internal/response'
import type { FetchInit, FetchOperation } from '../types'

export const fetch = (
  input: RequestInfo | URL,
  init?: FetchInit | undefined,
  shouldExpect = false,
): FetchOperation => {
  const runFetch = operation(function* () {
    try {
      const signal = yield* useAbortSignal()
      // oxlint-disable-next-line oxc/no-rest-spread-properties
      const response = yield* until(globalThis.fetch(input, { ...init, signal }))
      const wrapped = createFetchResponse(response)
      if (shouldExpect && !response.ok) {
        return yield* fail(
          'http-status',
          `${response.url}: ${response.status} ${response.statusText}`,
        )
      }
      return wrapped
    } catch (error) {
      const failure = asFailure(error)
      const kind = isAbortError(failure) ? 'abort' : 'network'
      return yield* fail(kind, `${String(input)}: ${errorMessage(failure)}`)
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

  const body = operation(function* () {
    const response = yield* runFetch()
    return yield* response.body()
  }, 'body')

  return Object.assign(base, {
    json: <T = unknown>() => json<T>(),
    text,
    arrayBuffer,
    blob,
    formData,
    bytes,
    body,
    expect: () => fetch(input, init, true),
  })
}
