import { chunks, CoreErrors, defineAction, isAction, parts, value } from 'server:core'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { catchFailure, runResult, runScoped } from '../helpers'

const Todo = z.object({ id: z.string(), title: z.string() })

describe('defineAction', () => {
  it('resolves the wire manifest once at definition time', () => {
    const upload = defineAction(
      { input: [value(z.object({ name: z.string() })), parts()], output: chunks() },
      function* (body) {
        return body as never
      },
    )

    expect(upload.meta.wire.input).toEqual(['value', 'parts'])
    expect(upload.meta.wire.output).toEqual(['chunks'])
    expect(upload.meta.wire.streamingIn).toBe(true)
    expect(upload.meta.wire.streamingOut).toBe(true)
    expect(upload.meta.wire.bytesOut).toBe(true)
    expect(isAction(upload)).toBe(true)
  })

  it('defaults: cancel on disconnect, empty policies and errors', () => {
    const action = defineAction(function* () {
      return 1
    })

    expect(action.meta.onDisconnect).toBe('cancel')
    expect(action.meta.policies).toEqual({})
    expect(action.meta.errors).toEqual({})
    expect(action.meta.wire.input).toEqual(['value'])
    expect(action.meta.wire.streamingOut).toBe(false)
  })

  it('validates input on the value plane', async () => {
    const get = defineAction({ input: z.object({ id: z.string() }) }, function* (body) {
      return body.id
    })

    const failure = await runResult(function* () {
      yield* get({ id: 42 as never })
    })

    expect(isFailure(failure)).toBe(true)
    if (isFailure(failure)) {
      expect(failure.error).toBe(CoreErrors.Validation)
      expect(failure.message).toContain('input validation failed')
    }

    const ok = await runScoped(function* () {
      return yield* get({ id: 'a1' })
    })

    expect(ok).toBe('a1')
  })

  it('validates output on the value plane', async () => {
    const bad = defineAction({ output: Todo }, function* () {
      return { id: 'x' } as never
    })

    const failure = await runResult(function* () {
      yield* bad(undefined as never)
    })

    expect(isFailure(failure)).toBe(true)
    if (isFailure(failure)) {
      expect(failure.error).toBe(CoreErrors.Validation)
      expect(failure.message).toContain('output validation failed')
    }
  })

  it('typed route/policies/errors land on meta', () => {
    const get = defineAction(
      {
        input: z.object({ id: z.string() }),
        route: { method: 'GET', path: '/:id' },
        policies: { cache: { ttlMs: 5000 }, retry: false },
        onDisconnect: 'detach',
        outcome: true,
        errors: { 'todos.not-found': 404 },
      },
      function* (body) {
        return body.id
      },
    )

    expect(get.meta.route).toEqual({ method: 'GET', path: '/:id' })
    expect(get.meta.policies).toEqual({ cache: { ttlMs: 5000 }, retry: false })
    expect(get.meta.onDisconnect).toBe('detach')
    expect(get.meta.outcome).toBe(true)
    expect(get.meta.errors).toEqual({ 'todos.not-found': 404 })
  })

  it('rejects malformed declarations at definition time', () => {
    const doubled = catchFailure(() =>
      defineAction({ input: [value(), value()] }, function* () {
        return 1
      }),
    )
    expect(doubled.error).toBe(CoreErrors.Configuration)
    expect(doubled.message).toBe('a declaration may carry at most one value channel')

    const empty = catchFailure(() =>
      defineAction({ input: [] as never }, function* () {
        return 1
      }),
    )
    expect(empty.error).toBe(CoreErrors.Configuration)
    expect(empty.message).toBe('a channel declaration array cannot be empty')
  })
})
