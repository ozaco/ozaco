/**
 * Inherited options in the TYPE of an action's `ctx`. `bun test` proves the runtime lines; the
 * compile-time contracts are the `@ts-expect-error` markers and the explicit annotations, which
 * `moon run cli:types` (tsc) checks — a marker that stops being an error is itself an error.
 *
 * Actions are defined standalone (as they would be in their own files) and name what they expect
 * with `inherits`: the root's inherited `input` schema (the cycle-free cross-file form) or a
 * command spec (which carries its declared ancestors' fields too).
 */
import { defineAction, defineCommand, DefaultRegistry, Registry } from 'cli:command'
import type { CommandDef } from 'cli:command'
import { DefaultPalette } from 'cli:palette'
import { run } from 'std:effect'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { createMemoryScreen, MemoryTerminal } from 'cli:impl/memory'
import { z } from 'zod'

/** What the root passes down — kept apart from the root so actions can import it cycle-free. */
const rootInput = z.object({
  profile: z.string().default('dev'),
  secret: z.string().optional(),
  region: z.enum(['eu', 'us']).default('eu'),
})

const seen: { ctx: AnyType } = { ctx: undefined }

const whoami = defineAction(
  { inherits: rootInput, input: z.object({ json: z.boolean().default(false) }) },
  function* (ctx) {
    const profile: string = ctx.profile
    const secret: string | undefined = ctx.secret
    const json: boolean = ctx.json
    const cwd: string = ctx.cwd

    seen.ctx = { profile, secret, json, cwd }
  },
)

/** The action's own `region` (a plain string) shadows the inherited enum, as at runtime. */
const move = defineAction(
  { inherits: rootInput, input: z.object({ region: z.string() }), args: ['region'] },
  function* (ctx) {
    const region: string = ctx.region
    // @ts-expect-error the own `region` is a string, not the inherited 'eu' | 'us'
    const narrow: 'eu' | 'us' = ctx.region

    seen.ctx = { region, narrow, profile: ctx.profile }
  },
)

/** No own input: `ctx` is the inherited fields plus the runtime ones. */
const ping = defineAction({ inherits: rootInput }, function* (ctx) {
  const profile: string = ctx.profile
  const rest: string[] = ctx['--']

  seen.ctx = { profile, rest }
})

/** A nested command naming its ancestors: what it passes down accumulates theirs. */
const kube = defineCommand({
  name: 'kube',
  inherits: rootInput,
  input: z.object({ context: z.string().default('local') }),
  actions: {
    apply: defineAction({ input: z.object({ file: z.string() }) }, function* (ctx) {
      seen.ctx = ctx
    }),
  },
})

/** Declared against the nested spec: sees the root's AND kube's fields. */
const status = defineAction({ inherits: kube }, function* (ctx) {
  const context: string = ctx.context
  const profile: string = ctx.profile

  seen.ctx = { context, profile }
})

const kubeWithStatus = defineCommand({
  name: 'kube',
  inherits: rootInput,
  input: z.object({ context: z.string().default('local') }),
  actions: { status },
})

const root = defineCommand({
  name: 'app',
  input: rootInput,
  actions: { whoami, move, ping, kube: kubeWithStatus },
})

/** Statements that must (or must not) COMPILE. Never called. */
const probe = (): void => {
  // an action without `inherits` sees only its own input
  defineAction({ input: z.object({ a: z.string() }) }, function* (ctx) {
    const a: string = ctx.a
    // @ts-expect-error nothing is inherited without `inherits`
    const profile: string = ctx.profile

    return [a, profile]
  })

  // the spec carries what it passes down (own over ancestors) and what it expects
  const passes: CommandDef.InheritedOf<typeof kube> = { context: 'x', profile: 'p', region: 'eu' }
  // @ts-expect-error `context` is required in what kube passes down
  const missing: CommandDef.InheritedOf<typeof kube> = { profile: 'p', region: 'eu' }

  // a helper typed off the same shape (e.g. an `accessOf(ctx)`)
  const accessOf = (ctx: CommandDef.Ctx<unknown, CommandDef.InheritedOf<typeof rootInput>>) =>
    ctx.profile

  defineAction({ inherits: rootInput }, function* (ctx) {
    return accessOf(ctx)
  })

  defineCommand({
    name: 'bare',
    actions: {
      // @ts-expect-error `bare` passes nothing down, but `whoami` expects the root's options
      whoami,
    },
  })

  defineCommand({
    name: 'partial',
    input: z.object({ profile: z.string() }),
    actions: {
      // @ts-expect-error `partial` passes `profile` but not `region`, which `ping` expects
      ping,
    },
  })

  // @ts-expect-error `inner` passes nothing down, but `status` expects kube's fields
  defineCommand({ name: 'inner', actions: { status } })

  const inner = defineCommand({ name: 'inner', inherits: kube, actions: { status } })

  defineCommand({ name: 'nested', inherits: kube, actions: { inner } })
  defineCommand({
    name: 'nested',
    input: rootInput,
    actions: {
      // @ts-expect-error `inner` expects kube's `context`, which a bare `input: rootInput` lacks
      inner,
    },
  })

  // a nested spec expecting the root's fields cannot go under a command that lacks them
  defineCommand({
    name: 'orphan',
    actions: {
      // @ts-expect-error `kube` declares `inherits: rootInput`
      kube,
    },
  })

  void [passes, missing, root]
}

const cli = async (argv: string[]) => {
  const screen = createMemoryScreen({ capabilities: { interactive: false } })

  seen.ctx = undefined
  await run(function* () {
    yield* MemoryTerminal.use({ screen })
    yield* DefaultPalette.use()
    yield* DefaultRegistry.use({ name: 'app' })
    yield* Registry.actions.register(root)
    yield* Registry.actions.run(argv)
  })

  return seen.ctx
}

describe('cli — inherited options typed in ctx', () => {
  it('an action declaring `inherits` reads the inherited values it is typed with', async () => {
    expect(await cli(['app', 'whoami', '--profile', 'prod', '--secret', 's3', '--json'])).toEqual({
      profile: 'prod',
      secret: 's3',
      json: true,
      cwd: process.cwd(),
    })
  })

  it("the action's own field of the same name wins", async () => {
    // one flag feeds both schemas at runtime, so the value has to satisfy the inherited enum too
    expect(await cli(['app', 'move', 'us'])).toEqual({
      region: 'us',
      narrow: 'us',
      profile: 'dev',
    })
  })

  it('inherited fields reach an action without its own input', async () => {
    expect(await cli(['app', 'ping', '--profile', 'ci', '--', 'x'])).toEqual({
      profile: 'ci',
      rest: ['x'],
    })
  })

  it('a nested command accumulates its ancestors (declared with `inherits`)', async () => {
    expect(await cli(['app', 'kube', 'status', '--context', 'prod'])).toEqual({
      context: 'prod',
      profile: 'dev',
    })
  })

  it('`inherits` is type-only — nothing of it lands on the action or spec', () => {
    expect('inherits' in whoami).toBe(false)
    expect('inherits' in kube).toBe(false)
    expect(typeof probe).toBe('function')
  })
})
