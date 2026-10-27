import type { Operation } from 'std:effect'
import { attempt, run, useContext } from 'std:effect'
import type { Target } from 'std:plugin'
import { defineProtocol, PluginErrors } from 'std:plugin'
import { fail, isFailure, unwrap } from 'std:result'
import type { StandardSchemaV1 } from 'std:shared'

import { describe, expect, it } from 'bun:test'

let uniq = 0
const name = (base: string) => `${base}-${++uniq}`

/** A minimal Standard Schema: an object with one required string field, trimmed on the way out. */
const field = (key: string): StandardSchemaV1<unknown, Record<string, string>> => ({
  '~standard': {
    version: 1,
    vendor: 'ozaco-tests',
    validate: value => {
      const raw = (value as Record<string, unknown> | null)?.[key]

      return typeof raw === 'string' && raw !== ''
        ? { value: { [key]: raw.trim() } }
        : { issues: [{ message: `${key} is required`, path: [key] }] }
    },
  },
})

const configSchema = field('url')
const secretsSchema = field('key')

interface ProviderActions extends Target.Lifecycle {
  account(): Operation<string>
  echo(text: string): Operation<string>
}

interface State {
  probes: number
  released: boolean
}

const makeProvider = () =>
  defineProtocol<unknown, ProviderActions>({
    name: name('provider'),
    version: '1.0.0',
    cloneable: true,
  })

const makeTarget = (Provider: ReturnType<typeof makeProvider>, label: string) =>
  Provider.target({
    name: label,
    version: '0.1.0',
    config: configSchema,
    secrets: secretsSchema,
    state: (): State => ({ probes: 0, released: false }),
    *probe({ config, state }) {
      state.probes += 1

      if (config.url === 'down') {
        return yield* fail('test.unreachable', 'the far side refused')
      }

      if (config.url === 'silent') {
        return yield* fail('test.unreachable', '', 'no route to host')
      }

      if (config.url === 'half') {
        return { ok: false, note: 'account suspended' }
      }

      return { ok: true, note: `connected · ${config.url}` }
    },
    *release(state) {
      state.released = true
    },
    actions: {
      *account({ config, secrets }) {
        return `${config.url}:${secrets.key}`
      },
      *echo({ state }, text) {
        return `${text}#${state.probes}`
      },
    },
  })

describe('protocol — target', () => {
  it('starts unbound: domain actions fail not-connected, the lifecycle answers not connected', async () => {
    const Provider = makeProvider()
    const Plugin = makeTarget(Provider, 'acme')

    unwrap(
      await run(function* () {
        yield* Plugin.use()

        expect(yield* Plugin.actions.isConnected()).toEqual({ ok: false, note: 'not connected' })

        const outcome = yield* attempt(() => Plugin.actions.account())

        expect(isFailure(outcome)).toBe(true)

        if (isFailure(outcome)) {
          expect(outcome.error).toBe(PluginErrors.NotConnected)
          expect(outcome.error).toBe('std:plugin.not-connected')
          expect(outcome.message).toBe('"acme" is not connected')
          expect(outcome.causes[0]).toBe('acme:disconnected')
        }
      }),
    )
  })

  it('rejects a binding the schemas refuse without probing', async () => {
    const Provider = makeProvider()
    const Plugin = makeTarget(Provider, 'acme')

    unwrap(
      await run(function* () {
        yield* Plugin.use()

        const health = yield* Plugin.actions.connect({ config: {}, secrets: { key: 'k' } })

        expect(health).toEqual({ ok: false, note: 'configuration incomplete' })
        expect(yield* Plugin.actions.isConnected()).toEqual(health)

        const context = yield* useContext(Plugin.context)

        expect(context.bound).toBeNull()
        expect(context.state.probes).toBe(0)
      }),
    )
  })

  it('turns a failing probe into health with the failure as the note, and stays unbound', async () => {
    const Provider = makeProvider()
    const Plugin = makeTarget(Provider, 'acme')

    unwrap(
      await run(function* () {
        yield* Plugin.use()

        const down = yield* Plugin.actions.connect({
          config: { url: 'down' },
          secrets: { key: 'k' },
        })

        expect(down).toEqual({ ok: false, note: 'the far side refused' })

        // an empty message falls back to the first cause
        const silent = yield* Plugin.actions.connect({
          config: { url: 'silent' },
          secrets: { key: 'k' },
        })

        expect(silent).toEqual({ ok: false, note: 'no route to host' })

        // a probe that answers `ok: false` is health as given — and does not bind either
        const half = yield* Plugin.actions.connect({
          config: { url: 'half' },
          secrets: { key: 'k' },
        })

        expect(half).toEqual({ ok: false, note: 'account suspended' })

        const outcome = yield* attempt(() => Plugin.actions.account())

        expect(isFailure(outcome) && outcome.error).toBe('std:plugin.not-connected')
      }),
    )
  })

  it('binds on an ok probe: actions receive the parsed binding and the state survives reconnects', async () => {
    const Provider = makeProvider()
    const Plugin = makeTarget(Provider, 'acme')

    unwrap(
      await run(function* () {
        yield* Plugin.use()

        const health = yield* Plugin.actions.connect({
          config: { url: ' https://api.test ' },
          secrets: { key: 'secret' },
        })

        expect(health).toEqual({ ok: true, note: 'connected · https://api.test' })
        expect(yield* Plugin.actions.account()).toBe('https://api.test:secret')
        expect(yield* Plugin.actions.echo('hi')).toBe('hi#1')

        yield* Plugin.actions.connect({ config: { url: 'https://b.test' }, secrets: { key: 's2' } })

        expect(yield* Plugin.actions.account()).toBe('https://b.test:s2')
        expect(yield* Plugin.actions.echo('again')).toBe('again#2')
      }),
    )
  })

  it('disconnect releases the state and forgets the binding', async () => {
    const Provider = makeProvider()
    const Plugin = makeTarget(Provider, 'acme')

    unwrap(
      await run(function* () {
        yield* Plugin.use()
        yield* Plugin.actions.connect({ config: { url: 'https://a.test' }, secrets: { key: 'k' } })
        yield* Plugin.actions.disconnect()

        const context = yield* useContext(Plugin.context)

        expect(context.state.released).toBe(true)
        expect(context.bound).toBeNull()
        expect(yield* Plugin.actions.isConnected()).toEqual({ ok: false, note: 'not connected' })

        const outcome = yield* attempt(() => Plugin.actions.account())

        expect(isFailure(outcome) && outcome.error).toBe('std:plugin.not-connected')
      }),
    )
  })

  it('several targets of one cloneable protocol hold their own binding', async () => {
    const Provider = makeProvider()
    const First = makeTarget(Provider, 'first')
    const Second = makeTarget(Provider, 'second')

    unwrap(
      await run(function* () {
        yield* First.use()
        yield* Second.use()
        yield* First.actions.connect({ config: { url: 'https://one.test' }, secrets: { key: '1' } })

        expect(yield* First.actions.account()).toBe('https://one.test:1')
        expect(yield* Second.actions.isConnected()).toEqual({ ok: false, note: 'not connected' })

        const outcome = yield* attempt(() => Second.actions.account())

        expect(isFailure(outcome) && outcome.causes[0]).toBe('second:disconnected')
      }),
    )
  })

  it('the built plugin is an ordinary implementation: tag, context and routed dispatch', async () => {
    const Provider = makeProvider()
    const Plugin = makeTarget(Provider, 'acme')

    expect(Plugin.tag).toBe('acme@0.1.0')
    expect(Plugin.getKeys().toSorted()).toEqual([
      'account',
      'connect',
      'disconnect',
      'echo',
      'isConnected',
    ])

    unwrap(
      await run(function* () {
        yield* Plugin.use()
        yield* Plugin.actions.connect({ config: { url: 'https://a.test' }, secrets: { key: 'k' } })

        // routed dispatch reaches the (only) installed target too
        expect(yield* Provider.actions.account()).toBe('https://a.test:k')
      }),
    )
  })
})
