import type { Response, TransportDef } from 'server:core'
import { DataType, Transport, lanesOf, valuesOf } from 'server:core'
import { Codec } from 'std:codec'
import type { Operation } from 'std:effect'
import {
  action,
  attempt,
  ensure,
  mapError,
  operation,
  race,
  sleep,
  until,
  useScope,
} from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail, isSuccess, just, nothing } from 'std:result'

import type { Msg } from 'nats'
import { DeliverPolicy, connect, headers as createHeaders } from 'nats'

import {
  DEFAULT_GROUP,
  DEFAULT_PREFIX,
  DEFAULT_REQUEST_TIMEOUT_MS,
  EMPTY_PAYLOAD,
  HDR_CID,
  HDR_REPLY,
  streamNames,
} from './const'
import { NatsErrors } from './errors'
import { brokerWathcer } from './internal/broker-watcher'
import { consume } from './internal/consume'
import { getSelf, useNatsContext } from './internal/context'
import { mapNatsFailure } from './internal/error-map'
import { handleFanout, handleQueued } from './internal/handlers'
import { pumpInputLanes, readLane } from './internal/lane'
import { ensureEventConsumer, provision, requireJetStream } from './internal/provision'
import {
  OUTPUT_LANE,
  cancelSubject,
  eventDurable,
  fanoutSubject,
  fanoutWildcard,
  isUnsafeToken,
  laneSubject,
  queuedSubject,
  queuedWildcard,
  replyInbox,
  rpcDurable,
  rpcSubject,
} from './internal/subjects'
import { unwrapWire } from './internal/wire'
import type { Nats } from './types'

const generateSid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export const NatsTransport = Transport.implement({
  name: 'server/nats-transport',
  version: '0.0.0',

  *setup(options: Nats.Options = {}) {
    const name = options.name ?? 'nats'
    const priority = options.priority ?? 10
    const next = options.next ?? (() => false)
    const prefix = options.subjectPrefix ?? DEFAULT_PREFIX
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    // kept RAW — `eventDurable` owns the flattening, and it fingerprints the raw name so two
    // groups that flatten alike ('billing.eu' / 'billing_eu') still get separate durables
    const group = options.queueGroup ?? DEFAULT_GROUP

    const scope = yield* useScope()

    const connection = yield* mapError(
      until(
        connect({
          servers: options.servers ?? 'nats://localhost:4222',
          reconnect: true,
        }),
        'nats:connect',
      ),
      mapNatsFailure,
    )

    const js = connection.jetstream()
    // The manager's own probe answers a JetStream-less server with a bare NATS "503", which used
    // to surface as `server:nats-transport.unknown: 503` and explain nothing — translate exactly
    // that case into the answer a human can act on. (Do NOT pass `checkAPI: false` to skip the
    // probe instead: on nats 2.29.3 a manager built that way hangs on its first API call.)
    const jsm = yield* mapError(
      until(connection.jetstreamManager(), 'nats:jetstream-manager'),
      failure =>
        (failure.error as { code?: string } | undefined)?.code === '503'
          ? (fail(
              NatsErrors.NoJetstream,
              `the NATS server at ${String(options.servers ?? 'nats://localhost:4222')} runs without JetStream — start it with -js`,
            ) as Result.Failure<unknown>)
          : mapNatsFailure(failure),
    )

    // Refuse a server without JetStream, THEN create the three streams — both before anything else
    // touches the wire, so a node built against a changed stream config fails at install, loudly.
    yield* requireJetStream(jsm)
    yield* provision(jsm, prefix)

    const consumers: Nats.Context['consumers'] = new Map()

    const context: Nats.Context = {
      name,
      priority,
      next,
      prefix,
      group,
      requestTimeoutMs,

      connection,
      js,
      jsm,
      consumers,
      scope,
    }

    /**
     * QUEUED events: one durable per GROUP, shared by every member, so each event reaches exactly
     * one of them — and survives a window where none of them was up, because the EVENT stream is
     * file-backed. FANOUT events: an ordered per-node consumer from `New`, because every node wants
     * its own copy of what happens from now on.
     */
    const qDurable = eventDurable(prefix, group)
    yield* ensureEventConsumer(jsm, prefix, qDurable, queuedWildcard(prefix))
    const queued = yield* until(
      js.consumers.get(streamNames(prefix).event, qDurable).then(consumer => consumer.consume()),
      'nats:event-queued',
    )
    consumers.set(`event:queued:${qDurable}`, queued)
    yield* consume(queued, handleQueued)

    const fanout = yield* until(
      js.consumers
        .get(streamNames(prefix).event, {
          filterSubjects: fanoutWildcard(prefix),
          deliver_policy: DeliverPolicy.New,
        })
        .then(consumer => consumer.consume()),
      'nats:event-fanout',
    )
    consumers.set('event:fanout', fanout)
    yield* consume(fanout, handleFanout)

    yield* brokerWathcer()

    yield* ensure(function* () {
      for (const [, messages] of consumers) {
        try {
          messages.stop()
        } catch {
          /* already stopped */
        }
      }
      consumers.clear()

      yield* Transport.actions.unregister(getSelf())
      yield* until(connection.close(), 'nats:unconnect')
    })

    yield* Transport.actions.register(getSelf(), context)

    return context
  },
}).build({
  /**
   * A real discovery answer, at last: the durable an address answers on either exists or it does
   * not. `nothing()` remains only for the moments the QUESTION itself failed — a broken connection
   * must not masquerade as "nobody serves this".
   *
   * This is what removes the loophole through which at-most-once became at-least-once: the router
   * dispatches to a `just(true)`, and a claim whose owner dies mid-call is a failure the caller
   * sees, never a body that runs twice.
   */
  hosts: operation(function* (service: string, path: string) {
    const nats = yield* useNatsContext()

    // this node consumes that subject itself — no round trip needed to know
    if (nats.consumers.has(rpcSubject(nats.prefix, service, path))) {
      return just(true)
    }

    const outcome = yield* attempt(
      until(
        nats.jsm.consumers.info(
          streamNames(nats.prefix).rpc,
          rpcDurable(nats.prefix, service, path),
        ),
        `nats:hosts ${service}.${path}`,
      ),
    )

    if (isSuccess(outcome)) {
      return just(true)
    }

    const error = (outcome as Result.Failure<unknown>).error as
      | { message?: string; api_error?: { err_code?: number } }
      | undefined
    const missing =
      error?.api_error?.err_code === 10_014 ||
      String(error?.message ?? '').includes('consumer not found')

    return missing ? just(false) : nothing()
  }),

  dispatch: operation(function* (req: TransportDef.DispatchRequest) {
    const nats = yield* useNatsContext()

    const cid = generateSid()
    const subject = rpcSubject(nats.prefix, req.service, req.path)

    /**
     * The reply is core NATS: it has exactly one recipient, who is subscribed and waiting, so
     * persisting it would mean delivering an answer to a caller that no longer exists. Subscribed
     * BEFORE the dispatch goes out — the owner may answer faster than this generator resumes.
     *
     * Callback mode, with the waiter parked on a plain `action`: the waiter is the losing side of
     * a race whenever the transport timeout fires first, and a task parked inside an `into(...)`
     * iterator cannot be halted cleanly.
     */
    let replyMsg: Msg | undefined
    let replyError: unknown
    let onReply: (() => void) | undefined

    const replySub = nats.connection.subscribe(replyInbox(nats.prefix, cid), {
      max: 1,
      callback: (error, msg) => {
        // a subscription-level error (permissions, forced close) is an ANSWER too — swallowing it
        // would park a timer-less dispatch forever
        if (error) {
          replyError = error
        } else {
          replyMsg = msg
        }
        onReply?.()
      },
    })

    yield* ensure(function* () {
      if (!replySub.isClosed()) {
        replySub.unsubscribe()
      }
    })

    /**
     * Cancel rides the dispatch scope's teardown — a caller that stops waiting tells the owner to
     * stop working. EXCEPT when the answer is a lane this scope handed onward: the dispatch
     * returning is then the beginning of the transfer, not the end of interest, and cancelling
     * here was precisely how every remote download died at chunk zero.
     */
    let adopted = false

    yield* ensure(function* () {
      if (!adopted) {
        nats.connection.publish(cancelSubject(nats.prefix, cid), EMPTY_PAYLOAD)
      }
    })

    const lanes = lanesOf(req.sources)
    const hasParts = req.sources.some(source => source.type === DataType.multistream)
    const params = valuesOf(req.sources)

    const payload: Nats.DispatchPayload = {
      serviceName: req.service,
      actionKey: req.path,
      // `origin` is mapped to a string here and back to the symbol on the far side, explicitly and
      // in one place: a codec turns a symbol into `undefined` without complaining, and `origin` is
      // the field an access check reads.
      origin: String(req.origin).includes('external') ? 'external' : 'internal',
      meta: req.meta,
      ...(req.wire === undefined ? {} : { wire: req.wire }),
      ...(params.length === 0 ? {} : { params }),
      ...(lanes.length === 0 && !hasParts
        ? {}
        : { lanes: { streams: lanes.length, parts: hasParts } }),
      ...(req.contexts === undefined ? {} : { contexts: req.contexts }),
    }

    const encoded = yield* Codec.actions.encode(payload)
    const dispatchHeaders = createHeaders()
    dispatchHeaders.set(HDR_REPLY, replyInbox(nats.prefix, cid))
    dispatchHeaders.set(HDR_CID, cid)

    // A PubAck is the work-queue saying "stored" — from here the call either reaches exactly one
    // owner or ages out, and a subject no stream covers errors HERE instead of timing out later.
    yield* mapError(
      until(
        nats.js.publish(subject, encoded as Uint8Array, { headers: dispatchHeaders }),
        `nats:dispatch ${subject}`,
      ),
      mapNatsFailure,
    )

    /**
     * Inputs flow IMMEDIATELY — not after the reply, which was the old deadlock: an action that
     * drains its input lane before answering waited on chunks the caller had not begun to send.
     * The LANE stream replays, so the owner's reader attaches whenever it likes and misses nothing.
     */
    pumpInputLanes(nats, cid, req)

    const awaitReply = (): Operation<Msg> =>
      action<Msg>((resolve, reject) => {
        const settle = () => {
          if (replyError === undefined) {
            resolve(replyMsg!)
          } else {
            reject(mapNatsFailure(asFailure(replyError)))
          }
        }
        if (replyMsg !== undefined || replyError !== undefined) {
          settle()
          return () => {}
        }
        onReply = settle
        return () => {
          onReply = undefined
        }
      }, `nats:await-reply ${subject}`)

    const expired = function* (): Operation<Msg> {
      yield* sleep(nats.requestTimeoutMs)
      return yield* fail(
        NatsErrors.Timeout,
        `no reply within ${nats.requestTimeoutMs}ms from ${subject}`,
      ) as Operation<never>
    }

    // `requestTimeoutMs <= 0` disables the transport timer entirely: the action `TimeoutPolicy`
    // is then the sole authority, and nothing here manufactures a fake ceiling.
    const reply =
      nats.requestTimeoutMs <= 0 ? yield* awaitReply() : yield* race([awaitReply(), expired()])

    const wire = (yield* Codec.actions.decode(reply.data)) as Nats.Wire

    if (wire._t === '__failure__') {
      return yield* unwrapWire(wire) as Operation<never>
    }

    if (wire._t === '__stream__') {
      adopted = true

      // the owner has begun publishing the lane already — or will; the LANE stream replays it
      const outputStream = yield* readLane(
        nats,
        laneSubject(nats.prefix, cid, 'out', OUTPUT_LANE),
        nats.scope,
      )

      return {
        status: wire.status,
        meta: wire.meta ?? {},
        sources: [{ type: DataType.stream, stream: outputStream }],
      } satisfies Response
    }

    // The status and headers the owner set, rebuilt on this side. They used to have nowhere to sit
    // on the reply, so `useResponse()` quietly did nothing the moment an action moved to another pod.
    return {
      status: wire.status,
      meta: wire.meta ?? {},
      sources: wire.value === undefined ? [] : [{ type: DataType.normal, value: wire.value }],
    } satisfies Response
  }),

  emit: operation(function* (req: TransportDef.EventRequest) {
    const nats = yield* useNatsContext()

    if (isUnsafeToken(req.name)) {
      return yield* fail(NatsErrors.BadSubject, `event name "${req.name}" is not subject-safe`)
    }

    // Delivery is in the SUBJECT (queued vs fanout); the target groups ride the payload, exactly
    // as they reach a local bus. One publish reaches each node-group once — the durable per group
    // does the splitting, so the publisher never learns which groups exist.
    const payload = yield* Codec.actions.encode(req)
    yield* mapError(
      until(
        nats.js.publish(queuedSubject(nats.prefix, req.name), payload as Uint8Array),
        `nats:emit ${req.name}`,
      ),
      mapNatsFailure,
    )

    // the wire OWNS this emit: the group durable hands it to exactly one member (possibly this
    // very node), so a local bus echo on top would be the second delivery this contract forbids
    return 'handled' as const
  }),

  broadcast: operation(function* (req: TransportDef.EventRequest) {
    const nats = yield* useNatsContext()

    if (isUnsafeToken(req.name)) {
      return yield* fail(NatsErrors.BadSubject, `event name "${req.name}" is not subject-safe`)
    }

    const payload = yield* Codec.actions.encode(req)
    yield* mapError(
      until(
        nats.js.publish(fanoutSubject(nats.prefix, req.name), payload as Uint8Array),
        `nats:broadcast ${req.name}`,
      ),
      mapNatsFailure,
    )
  }),
})
