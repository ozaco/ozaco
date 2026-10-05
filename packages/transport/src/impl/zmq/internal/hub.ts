// oxlint-disable import/exports-last
import type { Operation, Task } from 'std:effect'
import { attempt, ensure, fork, scoped, suspend, useScope, withResolvers } from 'std:effect'
import type { IODef } from 'std:io'
import { IO } from 'std:io'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'

import type { TransportDef } from 'transport:core'
import { logTransport, TransportErrors } from 'transport:core'
import type { Memory } from 'transport:impl/memory'
import { createLink, memoryDriver, MemoryTransport } from 'transport:impl/memory'

import type { Helpers } from '../types/helpers'

import { CMD, HUB_PREFIX, INPROC_HUBS } from './const'
import { zmtpLink } from './link'
import { empty, parseHeaders } from './wire'
import { str, text } from './zmtp'

/**
 * The hub: the broker every peer of a zmq install talks to. Its tables are a memory link — one
 * `MemoryTransport` install under {@link HUB_PREFIX} in the hub's own scope, so a peer's publish
 * is `memoryDriver.publish` (matching subscribers, one member per group, every durable; the
 * receipt is the count) and a peer's subscription is `memoryDriver.subscribe` pumped back as
 * `MSG` frames. A peer's subscriptions live exactly as long as its connection: when the link
 * closes, their scopes end and the memory link takes back what a durable member never acked.
 */

/** The hubs of this process by `inproc://` name — a connect finds its hub here. */
export const inprocHubs = (): Map<string, Helpers.Hub> => {
  const global = globalThis as { [INPROC_HUBS]?: Map<string, Helpers.Hub> }

  return (global[INPROC_HUBS] ??= new Map())
}

const none = (frame: Uint8Array | undefined): string | undefined => {
  const value = str(frame)

  return value === '' ? undefined : value
}

/** Answer one `SUB`: subscribe on the memory link and pump its deliveries to the peer until the
 * subscription (`UNSUB`), the peer (link closed) or the hub is gone. */
function* pump(
  link: Helpers.Link,
  frames: readonly Uint8Array[],
  inflight: Map<string, TransportDef.Raw>,
): Operation<void> {
  const [id, sid, pattern, group, durable] = frames
  const opened = yield* attempt(() =>
    memoryDriver.subscribe(str(pattern), { group: none(group), durable: none(durable) }),
  )

  if (isFailure(opened)) {
    yield* link.send([
      text(CMD.err),
      id ?? empty(),
      text(String(opened.error)),
      text(opened.message),
    ])

    return
  }

  yield* link.send([text(CMD.ok), id ?? empty()])

  for (;;) {
    const step = yield* opened.value.next()

    if (step.done) {
      return
    }

    const raw = step.value

    if (raw.seq !== undefined && raw.ack) {
      inflight.set(raw.seq, raw)
    }

    yield* link.send([
      text(CMD.msg),
      sid ?? empty(),
      text(raw.topic),
      text(raw.seq ?? ''),
      text(JSON.stringify(raw.headers)),
      raw.data,
    ])
  }
}

/** Serve one peer over its link until it says `BYE` or the link closes. Runs in the hub's scope
 * (the memory install is in reach); every subscription it opens is a child task. */
export function* servePeer(link: Helpers.Link): Operation<void> {
  const subscriptions = new Map<
    string,
    { readonly task: Task<void>; readonly inflight: Map<string, TransportDef.Raw> }
  >()

  for (;;) {
    const step = yield* link.messages.next()

    if (step.done) {
      return
    }

    const [cmd, ...rest] = step.value

    switch (str(cmd)) {
      case CMD.pub: {
        const [id, topic, headers, data] = rest
        const published = yield* attempt(() =>
          memoryDriver.publish({
            topic: str(topic),
            data: data ?? empty(),
            headers: parseHeaders(headers),
          }),
        )

        yield* link.send(
          isFailure(published)
            ? [text(CMD.err), id ?? empty(), text(String(published.error)), text(published.message)]
            : [text(CMD.ok), id ?? empty(), text(String(published.value ?? ''))],
        )

        break
      }
      case CMD.sub: {
        const sid = str(rest[1])
        const inflight = new Map<string, TransportDef.Raw>()
        const task = yield* fork(() => pump(link, rest, inflight))

        subscriptions.set(sid, { task, inflight })

        break
      }
      case CMD.unsub: {
        const sid = str(rest[0])
        const subscription = subscriptions.get(sid)

        subscriptions.delete(sid)

        if (subscription) {
          yield* subscription.task.halt()
        }

        break
      }
      case CMD.ack:
      case CMD.nak: {
        const [sid, seq] = rest
        const subscription = subscriptions.get(str(sid))
        const raw = subscription?.inflight.get(str(seq))

        if (subscription && raw) {
          subscription.inflight.delete(str(seq))

          const settle = str(cmd) === CMD.ack ? raw.ack : raw.nak

          if (settle) {
            yield* settle()
          }
        }

        break
      }
      case CMD.bye: {
        yield* link.close()

        return
      }
      default: {
        break
      }
    }
  }
}

/** A socket file a crashed hub left behind makes the bind fail `EADDRINUSE`, so an ipc bind
 * first dials the path: nobody answering ⇒ the file is stale and removed (logged); an answer ⇒ a
 * live hub owns it, the bind is left to fail honestly. */
function* unlinkStale(path: string, prefix: string): Operation<void> {
  if (!(yield* IO.actions.exists(path))) {
    return
  }

  const probe = yield* attempt(() => scoped(() => IO.actions.tcpConnect({ path })))

  if (!isFailure(probe)) {
    return
  }

  yield* attempt(() => IO.actions.rm(path, { force: true }))
  yield* logTransport('info', 'transport removed a stale ipc socket file', {
    'messaging.system': 'zmq',
    'ozaco.prefix': prefix,
    'network.peer.address': path,
  })
}

/**
 * Start a hub in a child scope of the caller (it lives as long as the install): the memory
 * install, then the endpoint — a tcp/ipc listener handshaking every connection as a ROUTER, or
 * an `inproc://` registration. Resolves the hub once bound; fails `transport.connection` when
 * the endpoint cannot be bound.
 */
export function* startHub(
  endpoint: IODef.Endpoint,
  options: {
    readonly prefix: string
    readonly link: Memory.Link | undefined
    readonly heartbeat: Helpers.HeartbeatSettings
  },
): Operation<Helpers.Hub> {
  const bound = withResolvers<Result<Helpers.Hub>>('zmq hub bound')

  yield* fork(function* () {
    const outcome = yield* attempt(function* () {
      yield* MemoryTransport.use({ prefix: HUB_PREFIX, link: options.link ?? createLink() })

      const scope = yield* useScope()

      if (endpoint.scheme === 'inproc') {
        const hubs = inprocHubs()

        if (hubs.has(endpoint.name)) {
          return yield* fail(
            TransportErrors.Configuration,
            `inproc://${endpoint.name} is already bound in this process`,
          )
        }

        const hub: Helpers.Hub = { scope, bound: yield* IO.actions.formatEndpoint(endpoint) }

        hubs.set(endpoint.name, hub)
        yield* ensure(() => {
          hubs.delete(endpoint.name)
        })

        return hub
      }

      if (endpoint.scheme === 'ipc') {
        yield* unlinkStale(endpoint.path, options.prefix)
      }

      const server = yield* IO.actions.tcpListen(
        endpoint.scheme === 'ipc'
          ? { path: endpoint.path }
          : { port: endpoint.port, hostname: endpoint.host },
        function* (socket) {
          const opened = yield* attempt(() => zmtpLink(socket, 'ROUTER', options.heartbeat))

          if (isFailure(opened)) {
            yield* logTransport('warn', 'transport peer rejected', {
              'messaging.system': 'zmq',
              'ozaco.prefix': options.prefix,
              'network.peer.address': socket.remoteAddress,
              error: opened,
            })

            return
          }

          yield* servePeer(opened.value)
        },
      )

      return {
        scope,
        bound: yield* IO.actions.formatEndpoint(
          endpoint.scheme === 'ipc' ? endpoint : { ...endpoint, port: server.port },
        ),
      }
    })

    bound.resolve(outcome)

    if (!isFailure(outcome)) {
      yield* suspend()
    }
  })

  const outcome = yield* bound.operation

  if (isFailure(outcome)) {
    return yield* fail(
      TransportErrors.Connection,
      `cannot bind ${yield* IO.actions.formatEndpoint(endpoint)}`,
      outcome,
    )
  }

  return outcome.value
}
