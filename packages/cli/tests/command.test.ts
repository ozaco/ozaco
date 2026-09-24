import { defineAction, defineCommand, DefaultRegistry, Registry } from 'cli:command'
import type { RegistryDef } from 'cli:command'
/**
 * The command runner end to end over the in-memory terminal: variadic positionals, the `--`
 * passthrough, inherited command options + the runtime `cwd`, help built from the input schema,
 * and failures reported exactly once (on stderr, marked so callers skip re-logging them).
 */
import { CliCauses, CliErrors, describeFailure, isReported } from 'cli:core'
import { DefaultPalette } from 'cli:palette'
import type { Operation } from 'std:effect'
import { attempt, run } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { createMemoryScreen, MemoryTerminal } from 'cli:impl/memory'
import { z } from 'zod'

const DomainErrors = { Down: 'app.down' } as const

const seen: { ctx: AnyType } = { ctx: undefined }

const app = defineCommand({
  name: 'app',
  description: 'the demo app',
  input: z.object({ verbose: z.boolean().default(false).describe('log more') }),
  short: { verbose: 'v' },
  examples: [{ run: 'app up web api', note: 'start two services' }],
  actions: {
    up: defineAction(
      {
        description: 'start services',
        input: z.object({
          detach: z.boolean().default(false).describe('run in the background'),
          services: z.array(z.string()).min(1).describe('services to start'),
        }),
        args: ['services'],
        examples: [{ run: 'app up web --detach' }],
      },
      function* (ctx) {
        seen.ctx = ctx
      },
    ),
    deploy: defineAction(
      {
        description: 'deploy a target',
        input: z.object({
          target: z.string().describe('where to deploy'),
          region: z.enum(['eu', 'us']).default('eu').describe('the region'),
          tag: z.string().describe('image tag'),
        }),
        args: ['target'],
      },
      function* (ctx) {
        seen.ctx = ctx
      },
    ),
    exec: defineAction({ input: z.object({ name: z.string() }), args: ['name'] }, function* (ctx) {
      seen.ctx = ctx
    }),
    broken: defineAction({ description: 'always fails' }, function* () {
      return yield* fail(DomainErrors.Down, 'the service is down', 'app.broken', 'app.broken')
    }),
    kube: defineCommand({
      name: 'kube',
      input: z.object({ context: z.string().default('local') }),
      actions: {
        apply: defineAction({ input: z.object({ file: z.string() }) }, function* (ctx) {
          seen.ctx = ctx
        }),
      },
    }),
  },
})

const boot = <T>(
  screen: ReturnType<typeof createMemoryScreen>,
  body: () => Operation<T>,
): Promise<AnyType> =>
  run(function* () {
    yield* MemoryTerminal.use({ screen })
    yield* DefaultPalette.use()
    yield* DefaultRegistry.use({ name: 'app' })
    yield* Registry.actions.register(app)

    return yield* body()
  })

const cli = async (argv: string[], options?: RegistryDef.RunOptions) => {
  const screen = createMemoryScreen({ capabilities: { interactive: false } })
  seen.ctx = undefined
  const outcome = await boot(screen, () => attempt(() => Registry.actions.run(argv, options)))
  return { outcome, screen, ctx: seen.ctx }
}

describe('cli — command positionals', () => {
  it('a trailing array arg collects every remaining positional', async () => {
    const { outcome, ctx } = await cli(['app', 'up', 'web', 'api', 'db', '--detach'])

    unwrap(outcome)
    expect(ctx.services).toEqual(['web', 'api', 'db'])
    expect(ctx.detach).toBe(true)
  })

  it('surplus positionals fail cli.parse instead of being dropped', async () => {
    const { outcome, screen, ctx } = await cli(['app', 'exec', 'one', 'two', 'three'])

    expect(isFailure(outcome) && outcome.error).toBe(CliErrors.Parse)
    expect(outcome.message).toBe("Unexpected arguments 'two', 'three'")
    expect(ctx).toBeUndefined()
    expect(screen.plain('stderr')).toContain("Unexpected arguments 'two', 'three'")
  })
})

describe('cli — `--` passthrough', () => {
  it('exposes the tokens after `--` as ctx["--"], never parsing them', async () => {
    const { outcome, ctx } = await cli(['app', 'exec', 'node', '--', '--help', '-V', 'x'])

    unwrap(outcome)
    expect(ctx.name).toBe('node')
    expect(ctx['--']).toEqual(['--help', '-V', 'x'])
  })

  it('an empty passthrough is an empty array', async () => {
    const { ctx } = await cli(['app', 'exec', 'node'])

    expect(ctx['--']).toEqual([])
  })

  it('--help after `--` does not take over', async () => {
    const { outcome, screen, ctx } = await cli(['app', 'up', 'web', '--', '--help'])

    unwrap(outcome)
    expect(ctx['--']).toEqual(['--help'])
    expect(screen.plain()).not.toContain('Usage:')
  })
})

describe('cli — inherited options and cwd', () => {
  it('merges a command-level input (and short flag) into every descendant action', async () => {
    const { outcome, ctx } = await cli(['app', 'up', 'web', '-v'])

    unwrap(outcome)
    expect(ctx.verbose).toBe(true)
    expect(ctx.services).toEqual(['web'])
  })

  it('applies inherited defaults and inherits through nested commands', async () => {
    const { outcome, ctx } = await cli([
      'app',
      'kube',
      'apply',
      '--file',
      'a.yml',
      '--context',
      'prod',
    ])

    unwrap(outcome)
    expect(ctx).toMatchObject({ file: 'a.yml', context: 'prod', verbose: false })
  })

  it('provides the runtime cwd, read when the command runs', async () => {
    const { ctx } = await cli(['app', 'exec', 'x'])
    expect(ctx.cwd).toBe(process.cwd())

    const custom = await cli(['app', 'exec', 'x'], { cwd: '/srv/app' })
    expect(custom.ctx.cwd).toBe('/srv/app')
  })
})

describe('cli — failure reporting', () => {
  it('renders parser failures as a short message, once, on stderr', async () => {
    const { outcome, screen } = await cli(['app', 'exec', 'x', '--bogus'])

    expect(isFailure(outcome) && outcome.error).toBe(CliErrors.Parse)
    expect(outcome.message).toBe("Unknown option '--bogus'")
    expect(isReported(outcome)).toBe(true)

    const err = screen.plain('stderr')
    expect(err.startsWith("Unknown option '--bogus'\n")).toBe(true)
    expect(err.match(/Unknown option/gu)).toHaveLength(1)
    expect(err).not.toContain('{')
    expect(screen.plain()).toBe('')
  })

  it('marks an unknown command reported', async () => {
    const { outcome, screen } = await cli(['nope'])

    expect(isFailure(outcome) && outcome.error).toBe(CliErrors.Unknown)
    expect(outcome.causes).toContain(CliCauses.Reported)
    expect(screen.plain('stderr')).toContain("Unknown command 'nope'")
  })

  it('without report, a handler failure passes through unrendered', async () => {
    const { outcome, screen } = await cli(['app', 'broken'])

    expect(isFailure(outcome) && outcome.error).toBe(DomainErrors.Down)
    expect(isReported(outcome)).toBe(false)
    expect(screen.plain('stderr')).toBe('')
  })

  it('with report, a handler failure is rendered once as tag: message + causes', async () => {
    const { outcome, screen } = await cli(['app', 'broken'], { report: true })

    expect(isFailure(outcome) && outcome.error).toBe(DomainErrors.Down)
    expect(isReported(outcome)).toBe(true)
    const err = screen.plain('stderr')
    expect(err.startsWith('app.down: the service is down\n  causes: app.broken › ')).toBe(true)
    expect(err.match(/app\.down/gu)).toHaveLength(1)
    expect(err.match(/app\.broken/gu)).toHaveLength(1)
    expect(err).not.toContain(CliCauses.Reported)
    // the plugin runtime keeps appending causes while the failure unwinds past the report
    expect(describeFailure(fail('x.tag', 'boom', 'a', 'a', CliCauses.Reported, 'b'))).toBe(
      'x.tag: boom\n  causes: a › b',
    )
  })

  it('with report, an already-rendered parse failure is not rendered again', async () => {
    const { outcome, screen } = await cli(['app', 'exec'], { report: true })

    expect(isFailure(outcome) && outcome.error).toBe(CliErrors.Parse)
    expect(screen.plain('stderr').match(/cli\.parse/gu)).toBeNull()
    expect(screen.plain('stderr')).toContain('Usage: app exec')
  })
})

describe('cli — help', () => {
  it('renders positionals, descriptions, defaults, required marks and examples', async () => {
    const { screen } = await cli(['app', 'deploy', '--help'])
    const out = screen.plain()

    expect(out).toContain('deploy a target')
    expect(out).toContain('Usage: app deploy [options] <target>')
    expect(out).toMatch(/Arguments:\n {2}<target> {2}where to deploy \(required\)/u)
    expect(out).not.toContain('--target')
    expect(out).toMatch(/--region <value> {2}the region \(choices: eu\|us, default: "eu"\)/u)
    expect(out).toMatch(/--tag <value> {5}image tag \(required\)/u)
    expect(out).toMatch(/-v, --verbose {5}log more \(default: false\)/u)
  })

  it('marks a variadic trailing positional and lists action examples', async () => {
    const { screen } = await cli(['app', 'up', '-h'])
    const out = screen.plain()

    expect(out).toContain('Usage: app up [options] <services...>')
    expect(out).toContain('Examples:\n  app up web --detach')
  })

  it('lists command examples in the group help', async () => {
    const { screen } = await cli(['app'])
    const out = screen.plain()

    expect(out).toContain('Commands:')
    expect(out).toContain('Examples:\n  app up web api  start two services')
  })
})
