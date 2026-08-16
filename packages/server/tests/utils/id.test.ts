import { actionId, correlationId, createId, instanceId, randomHex, requestId } from 'server:utils'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'

import { runResult, runScoped } from '../helpers'

// Crockford's base32 alphabet (no I/L/O/U); a standard ULID body is 26 chars.
const ULID_TAIL = /^[0-9A-HJKMNP-TV-Z]{26}$/u

describe('id', () => {
  it('randomHex produces lowercase hex twice the byte length', async () => {
    const hex = await runScoped(function* () {
      yield* install(BunIO)
      return yield* randomHex(8)
    })

    expect(hex).toMatch(/^[0-9a-f]{16}$/u)
  })

  it('createId prefixes a ULID tail', async () => {
    const id = await runScoped(function* () {
      yield* install(BunIO)
      return yield* createId('svc')
    })

    const [prefix, tail] = [id.slice(0, 4), id.slice(4)]
    expect(prefix).toBe('svc_')
    expect(tail).toMatch(ULID_TAIL)
  })

  it('well-known helpers use their reserved prefixes with ULID tails', async () => {
    const [request, action, correlation, instance] = await runScoped(function* () {
      yield* install(BunIO)
      return [
        yield* requestId(),
        yield* actionId(),
        yield* correlationId(),
        yield* instanceId(),
      ] as const
    })

    for (const [id, prefix] of [
      [request, 'r_'],
      [action, 'a_'],
      [correlation, 'c_'],
      [instance, 'i_'],
    ] as const) {
      expect(id.startsWith(prefix)).toBe(true)
      expect(id.slice(prefix.length)).toMatch(ULID_TAIL)
    }
  })

  it('generates unique, sortable ids across calls', async () => {
    const [one, two] = await runScoped(function* () {
      yield* install(BunIO)
      return [yield* requestId(), yield* requestId()] as const
    })

    expect(one).not.toBe(two)
    expect(one < two).toBe(true) // ULIDs are monotonic within a window
  })

  it('fails with missing-action when no IO impl is installed', async () => {
    const outcome = await runResult(() => createId('svc'))

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('missing-action')
    }
  })

  it('randomHex fails with missing-action when no IO impl is installed', async () => {
    const outcome = await runResult(() => randomHex(4))

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('missing-action')
    }
  })
})
