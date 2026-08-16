import { breadcrumb, childTrace, laneOf, rootTrace, withServiceId } from 'server:core'
import { install } from 'std:plugin'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'

import { runScoped } from '../helpers'

describe('trace', () => {
  it('mints roots, extends lanes, renders breadcrumbs', async () => {
    const result = await runScoped(function* () {
      yield* install(BunIO)

      const root = yield* rootTrace({ origin: 'external', serviceId: 'gw#1', requestId: 'r_fixed' })
      const hop1 = yield* childTrace(root, {
        service: 'todos',
        action: 'create',
        transport: 'internal',
      })
      const hop2 = yield* childTrace(withServiceId(hop1, 'todos@1#a'), {
        service: 'ai',
        action: 'chat',
        transport: 'nats',
      })

      return { root, hop1, hop2 }
    })

    expect(result.root.requestId).toBe('r_fixed')
    expect(result.root.lane).toHaveLength(0)
    expect(result.root.actionId).toMatch(/^a_/u)

    expect(result.hop1.requestId).toBe('r_fixed')
    expect(result.hop1.parentActionId).toBe(result.root.actionId)
    expect(laneOf(result.hop1)).toBe('todos')

    expect(result.hop2.requestId).toBe('r_fixed')
    expect(result.hop2.parentActionId).toBe(result.hop1.actionId)
    expect(result.hop2.serviceId).toBe('todos@1#a')
    expect(laneOf(result.hop2)).toBe('todos>ai')
    expect(result.hop2.lane[1]?.transport).toBe('nats')

    const crumb = breadcrumb(withServiceId(result.hop2, 'ai@1#b'), 'chat')

    expect(crumb).toBe(`action:chat(${result.hop2.actionId}) svc:ai@1#b req:r_fixed lane:todos>ai`)
  })

  it('mints a fresh requestId when none is given', async () => {
    const result = await runScoped(function* () {
      yield* install(BunIO)

      const a = yield* rootTrace({ origin: 'internal', serviceId: 'x#1' })
      const b = yield* rootTrace({ origin: 'internal', serviceId: 'x#1' })

      return { a, b }
    })

    expect(result.a.requestId).toMatch(/^r_/u)
    expect(result.a.requestId).not.toBe(result.b.requestId)
  })
})
