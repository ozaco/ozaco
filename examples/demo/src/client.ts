// oxlint-disable import/exports-last
/**
 * The typed client walk-through: `bun run src/client.ts [http://127.0.0.1:3000]` against a
 * running demo. Every step prints what it did; `walk()` is what the e2e test runs too.
 */
import { createClient } from '@ozaco/client'
import type { ClientDef } from '@ozaco/client'
import type { Flow, Operation } from '@ozaco/std/effect'
import { attempt, run, scoped, sleep, until } from '@ozaco/std/effect'
import { isFailure, unwrap } from '@ozaco/std/result'

import type { Api } from './app'

export interface Step {
  readonly name: string
  readonly detail: unknown
}

function* drain<T>(flow: Flow<T, void>, max = Infinity): Operation<T[]> {
  const out: T[] = []
  const subscription = yield* flow

  while (out.length < max) {
    const step = yield* subscription.next()

    if (step.done) {
      break
    }

    out.push(step.value)
  }

  return out
}

const bytesOf = (size: number): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size).fill(1))
      controller.close()
    },
  })

/** Run every use case once; resolves the steps (the test asserts on them). */
export function* walk(url: string, report: (step: Step) => void = () => {}): Operation<Step[]> {
  const steps: Step[] = []

  const note = (name: string, detail: unknown) => {
    steps.push({ name, detail })
    report({ name, detail })
  }
  const client = yield* createClient<Api>({ url })

  // --- manifest + docs --------------------------------------------------------------------
  const manifest = yield* client.$manifest()

  note('manifest', {
    services: manifest.services.map(service => service.name),
    sockets: manifest.sockets?.map(socket => socket.path),
  })

  // --- auth: login → whoami → refresh → role gate ----------------------------------------
  const anonymous = yield* attempt(client.account.whoami())
  note('whoami anonymous', isFailure(anonymous) ? anonymous.error : anonymous.value)
  const tokens = yield* client.account.login({ email: 'ada@example.com', password: 'ada' })
  client.$setToken(tokens.accessToken)
  const me = yield* client.account.whoami()
  note('login + whoami', me)
  const rotated = yield* client.account.refresh({ refreshToken: tokens.refreshToken! })
  note('refresh', { rotated: rotated.refreshToken !== tokens.refreshToken })
  const replay = yield* attempt(client.account.refresh({ refreshToken: tokens.refreshToken! }))
  note('refresh replay', isFailure(replay) ? replay.error : 'accepted?!')
  client.$setToken(rotated.accessToken)
  const promoted = yield* client.account.promote({ email: 'bob@example.com' })
  note('admin-only promote', promoted)

  // --- crud resource + optimistic concurrency --------------------------------------------
  const created = yield* client.todos.create({ title: 'write the demo', priority: 'high' })
  const updated = yield* client.todos.update({ id: created._id, done: true })

  const stale = yield* attempt(
    client.todos.update(
      { id: created._id, title: 'stale' },
      { headers: { 'if-match': created._version } },
    ),
  )
  const page = yield* client.todos.list({ limit: 10, order: '_created_at', direction: 'desc' })

  note('todos crud', {
    created: created.title,
    updatedDone: updated.done,
    staleWrite: isFailure(stale) ? stale.error : 'accepted?!',
    listed: page.data.length,
  })

  // --- realtime watch (sync + delta) ------------------------------------------------------
  yield* scoped(function* () {
    const rows = yield* client.$rows<{ _id: string; title: string }>('todos')
    const first = yield* rows.next()
    yield* client.todos.create({ title: 'seen live' })
    const second = yield* rows.next()
    note('realtime watch', {
      syncRows: (first.value as ClientDef.Materialized).rows.length,
      afterCreate: (second.value as ClientDef.Materialized).rows.length,
    })
  })

  // --- crud hooks: before trims, after projects, around guards, error tags ---------------
  const padded = yield* client.todos.create({ title: '  hooked  ', priority: 'high' })
  const shouted = yield* client.todos.get({ id: padded._id })
  const guarded = yield* client.todos.create({ title: '[keep] forever' })
  const denied = yield* attempt(client.todos.remove({ id: guarded._id }))
  const ghost = yield* attempt(client.todos.get({ id: 'missing' }))
  // releasing the guard makes the row removable again (the walk nets zero rows)
  yield* client.todos.update({ id: guarded._id, title: 'released' })
  yield* client.todos.remove({ id: guarded._id })
  yield* client.todos.remove({ id: padded._id })

  note('crud hooks', {
    trimmed: padded.title,
    shouted: shouted.title,
    removeDenied: isFailure(denied) ? denied.error : 'removed?!',
    errorTagged: isFailure(ghost) ? ghost.causes.includes('todos:get') : 'found?!',
  })

  // --- crud actions + extend: a custom action on the resource, `replace` switched off --------
  const stats = yield* client.todos.stats()
  const noReplace = yield* attempt(client.$call('todos.replace', { id: 'x', title: 'x' }))

  note('crud extend', {
    stats,
    replaceDisabled: isFailure(noReplace) ? noReplace.error : 'accepted?!',
  })

  // --- crud schema: the definition-time hook tightened the create input ------------------
  const short = yield* attempt(client.todos.create({ title: 'no' }))
  note('crud schema', { rejected: isFailure(short) ? short.error : 'accepted?!' })

  // --- streams: ndjson / sse / text / bytes ----------------------------------------------
  const ticks = yield* drain(yield* client.feed.ticks({ n: 3, everyMs: 5 }))
  const events = yield* drain(yield* client.feed.events({ n: 2, everyMs: 5 }))
  const words = yield* client.feed.words({ text: 'a b c' })
  const download = yield* client.feed.download({ kb: 4 })
  const downloaded = yield* until(new Response(download).arrayBuffer())

  note('streams', {
    ndjson: ticks.length,
    sse: events.length,
    text: words,
    bytes: downloaded.byteLength,
  })

  // --- uploads: multipart parts + raw body; cached list invalidated by the table ---------
  const before = yield* client.media.list()

  const upload = yield* client.media.upload({
    fields: { name: 'photo.bin', mime: 'image/png' },
    streams: { file: new Uint8Array(3000) },
  })
  const ingest = yield* client.media.ingest(bytesOf(5000))
  yield* sleep(50)
  const after = yield* client.media.list()
  const stored = yield* client.media.download({ id: upload.id })
  const storedBytes = yield* until(new Response(stored).arrayBuffer())
  const missing = yield* attempt(client.media.download({ id: 'nope' }))

  note('uploads', {
    upload: upload.size,
    ingest: ingest.size,
    listBefore: before.length,
    listAfter: after.length,
    downloaded: storedBytes.byteLength,
    missing: isFailure(missing) ? missing.error : 'accepted?!',
  })

  // --- cache + resilience ---------------------------------------------------------------
  const summary1 = yield* client.reports.summary({})
  const summary2 = yield* client.reports.summary({})
  yield* client.reports.reset()
  const summary3 = yield* client.reports.summary({})

  note('cache', {
    hit: summary1.computedAt === summary2.computedAt,
    recomputedAfterInvalidate: summary3.computations > summary1.computations,
  })
  const flaky = yield* client.reports.flaky({ failTimes: 2 })
  const fallback = yield* client.reports.eventually({ ms: 500 })
  const limited: string[] = []

  for (let index = 0; index < 5; index += 1) {
    const outcome = yield* attempt(client.reports.limited())
    limited.push(isFailure(outcome) ? String(outcome.error) : 'ok')
  }

  const boomed: string[] = []

  for (let index = 0; index < 4; index += 1) {
    const outcome = yield* attempt(client.reports.guarded({ boom: true }))
    boomed.push(isFailure(outcome) ? String(outcome.error) : 'ok')
  }

  note('resilience', {
    retryAttempts: flaky.attempts,
    fallback: fallback.value,
    limited,
    breaker: boomed,
  })
  const overview = yield* client.reports.overview()
  note('nested ctx.call', overview)

  // --- events + sse relay ---------------------------------------------------------------
  const relayed = yield* scoped(function* () {
    const listen = yield* client.live.listen({ name: 'demo.ping', max: 1 })
    yield* sleep(50)
    yield* client.live.notify({ name: 'demo.ping', payload: { hello: 'world' } })
    return yield* drain(listen, 1)
  })

  note(
    'events',
    relayed.map(event => event.name),
  )

  // --- deadline / cancel ----------------------------------------------------------------
  const slow = yield* attempt(client.feed.slow({ ms: 50 }, { timeoutMs: 2000 }))
  note('slow within deadline', isFailure(slow) ? slow.error : slow.value)

  // --- cluster ----------------------------------------------------------------------------
  const ping = yield* client.cluster.ping()
  const members = yield* client.cluster.members()

  note('cluster', {
    servedBy: ping.instance,
    members: Object.fromEntries(
      Object.entries(members).map(([name, list]) => [name, list.map(member => member.instance)]),
    ),
  })

  // --- failure fidelity -----------------------------------------------------------------
  const invalid = yield* attempt(client.todos.create({ title: 1 } as never))

  note(
    'validation failure',
    isFailure(invalid) ? { tag: invalid.error, causes: invalid.causes.slice(0, 2) } : 'accepted?!',
  )
  note('last request id', client.$lastRequestId())

  return steps
}

if (import.meta.main) {
  const url = process.argv[2] ?? 'http://127.0.0.1:3000'

  unwrap(
    await run(function* () {
      yield* walk(url, step => {
        console.log(`• ${step.name}:`, JSON.stringify(step.detail))
      })
    }),
  )
}
