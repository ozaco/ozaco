import { Codec } from 'std:codec'
import type { Operation, Queue } from 'std:effect'
import { fork, within } from 'std:effect'
import { IO } from 'std:io'
import { fail } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'
import type { TransportDef } from 'transport:core'
import {
  isValidPrefix,
  Transport,
  transportActions,
  TransportErrors,
  watchStatus,
} from 'transport:core'

import pkg from '../../../package.json'

import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_OFFLINE_TIMEOUT_MS } from './internal/const'
import { driver, setStatus, StateRef } from './internal/driver'
import { inprocHubs, servePeer, startHub } from './internal/hub'
import { heartbeatOf, pairLinks, zmtpLink } from './internal/link'
import { createPeer } from './internal/peer'
import type { Helpers } from './types/helpers'
import type { Zmq } from './types/zmq'

/**
 * ZeroMQ transport — ZMTP 3.1 spoken in TypeScript over `std:io` sockets, no native binding:
 * `ZmqTransport.use({ prefix, bind: 'tcp://*:5555' })` is the hub (a ROUTER every peer
 * connects to; `ipc:///path.sock` and `inproc://name` bind the same way),
 * `ZmqTransport.use({ prefix, connect: 'tcp://host:5555' })` joins it (a DEALER; redials for as
 * long as it lives). zmq itself is brokerless, so the hub is what makes the whole `Transport`
 * surface work over it: wildcards, competing-consumer groups, durables (held in the hub's
 * memory — as long as the hub lives), receipts (a publish is one round trip, its answer the
 * receiver count — `no-responders` is instant). Every install, the hub's own included, talks to
 * the hub the same way. `JsonCodec` is installed unless the scope has a codec.
 */
export const ZmqTransport = Transport.implement<TransportDef.Options, [options: Zmq.Options]>({
  name: 'transport-zmq',
  version: pkg.version,
  description: 'ZeroMQ transport: ZMTP 3.1 over tcp / ipc / inproc, hub topology',

  *setup(options) {
    if (!(yield* Codec.actions.hasCodec())) {
      yield* JsonCodec.use()
    }

    if (!isValidPrefix(options.prefix)) {
      return yield* fail(TransportErrors.Configuration, `invalid prefix "${options.prefix}"`)
    }

    const given = options.bind ?? options.connect
    const endpoint = yield* IO.actions.parseEndpoint(given)

    if (endpoint === null) {
      return yield* fail(TransportErrors.Configuration, `invalid zmq endpoint "${given}"`)
    }

    /** attach to a hub of this process: a link pair, its far end served in the hub's scope */
    const attach = function* (hub: Helpers.Hub): Operation<Helpers.Link> {
      const [mine, theirs] = pairLinks()

      yield* fork(() => within(hub.scope, () => servePeer(theirs)))

      return mine
    }

    let bound: string | null = null
    let dial: () => Operation<Helpers.Link>

    if (options.bind !== undefined) {
      const hub = yield* startHub(endpoint, {
        prefix: options.prefix,
        link: options.link,
        heartbeat: heartbeatOf(options.heartbeat),
      })

      bound = hub.bound
      dial = () => attach(hub)
    } else if (endpoint.scheme === 'inproc') {
      dial = function* () {
        const hub = inprocHubs().get(endpoint.name)

        return hub
          ? yield* attach(hub)
          : yield* fail(TransportErrors.Connection, `nobody is bound at ${given} in this process`)
      }
    } else {
      dial = function* () {
        const socket = yield* IO.actions.tcpConnect(
          endpoint.scheme === 'ipc'
            ? { path: endpoint.path }
            : { hostname: endpoint.host, port: endpoint.port },
        )

        return yield* zmtpLink(socket, 'DEALER', heartbeatOf(options.heartbeat))
      }
    }

    const holder: { state?: Zmq.State } = {}
    const peer = yield* createPeer(dial, {
      // the hub's own install never loses its hub: when that link ends, so has the install
      redial: options.bind === undefined,
      firstTimeoutMs:
        options.bind === undefined
          ? (options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
          : DEFAULT_CONNECT_TIMEOUT_MS,
      offlineMs:
        options.bind === undefined
          ? (options.offlineTimeoutMs ?? DEFAULT_OFFLINE_TIMEOUT_MS)
          : DEFAULT_OFFLINE_TIMEOUT_MS,
      onStatus: status => {
        if (holder.state) {
          setStatus(holder.state, status)
        }
      },
    })
    const state: Zmq.State = {
      prefix: options.prefix,
      endpoint: given,
      bound,
      peer,
      status: 'connected',
      watchers: new Set<Queue<TransportDef.Status, void>>(),
      drained: false,
    }

    holder.state = state
    yield* StateRef.set(state)
    // connection lost / back / closed → the Logger, while the install lives
    yield* watchStatus(driver.status(), { transport: 'zmq', prefix: options.prefix })

    return { transport: 'zmq', prefix: options.prefix, capabilities: driver.capabilities }
  },
}).build(transportActions(driver))
