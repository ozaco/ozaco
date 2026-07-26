import type { ResponseSink, Service, TransportDef } from 'server:core'
import {
  ActionResponseContext,
  Broker,
  DataType,
  ResponseSinkContext,
  emptyDraft,
  producesLane,
  toResponse,
} from 'server:core'
import { Codec } from 'std:codec'
import type { Operation, Stream } from 'std:effect'
import { action, attempt, ensure, operation, race, useContext } from 'std:effect'
import { Logger } from 'std:logger'
import type { Result } from 'std:result'
import { fail, isSuccess } from 'std:result'

import type { JsMsg } from 'nats'

import { invokeAction } from '../../shared/invoke'
import { HDR_CID, HDR_REPLY } from '../const'
import type { Nats } from '../types'

import { useNatsContext } from './context'
import { captureInputLanes, pumpLane } from './lane'
import { cancelSubject, laneSubject, OUTPUT_LANE } from './subjects'
import { encodeReply, wireFailure, wireStream, wireSuccess } from './wire'

/**
 * One received event, re-emitted onto the local bus.
 *
 * `queued` events are acked AFTER the bus emit — the ack is what takes the event off the group's
 * durable, so a member that dies mid-emit leaves it for a sibling. Fanout events arrive on an
 * ordered consumer, which has nothing to ack.
 */
const handleEvent = (kind: 'event.emit' | 'event.broadcast', acked: boolean) =>
  operation(function* (msg: JsMsg) {
    // A listener that throws must cost neither the consume loop nor another group's event: the
    // emit is attempted, and the ack comes LAST — a handler halted mid-way (shutdown) leaves the
    // event unacked for a sibling, while an undecodable one is acked as poison rather than
    // redelivered forever.
    const decoded = yield* attempt(Codec.actions.decode(msg.data))

    if (isSuccess(decoded)) {
      const broker = yield* useContext(Broker)
      yield* attempt(function* () {
        broker.bus.emit(kind, decoded.value as TransportDef.EventRequest)
      })
    }

    if (acked) {
      try {
        msg.ack()
      } catch {
        /* consumer may already be gone */
      }
    }
  })

export const handleQueued = handleEvent('event.emit', true)
export const handleFanout = handleEvent('event.broadcast', false)

export const handleDispatch = (service: Service, actionKey: string) =>
  operation(function* (msg: JsMsg) {
    const nats = yield* useNatsContext()

    const replyTo = msg.headers?.get(HDR_REPLY) || undefined
    const cid = msg.headers?.get(HDR_CID) || undefined

    /**
     * The ack is the promise that this call will not be handed to anyone else — and with
     * `max_deliver: 1` it is also the last word on it. It fires AFTER the reply is published,
     * never before, and exactly once no matter which path gets there.
     */
    let acked = false
    const ack = () => {
      if (acked) {
        return
      }
      acked = true
      try {
        msg.ack()
      } catch {
        /* connection may already be torn down */
      }
    }

    let responded = false
    const respond = function* (wire: Nats.Wire) {
      if (!responded && replyTo) {
        responded = true
        try {
          nats.connection.publish(replyTo, yield* encodeReply(wire))
        } catch {
          /* unreachable caller */
        }
      }
      ack()
    }

    const decoded = yield* attempt(Codec.actions.decode(msg.data))

    if (!isSuccess(decoded)) {
      yield* respond(wireFailure(decoded))
      return
    }

    const req = decoded.value as Nats.DispatchPayload

    /**
     * The cancel subscription is CALLBACK mode, and the waiter below parks on a plain `action`.
     * Both matter: a task parked inside an `into(...)` iterator cannot be halted cleanly, and the
     * losing side of the race below is halted on every single call.
     */
    let cancelled = false
    let onCancel: (() => void) | undefined

    const cancelSub = cid
      ? nats.connection.subscribe(cancelSubject(nats.prefix, cid), {
          max: 1,
          callback: () => {
            cancelled = true
            onCancel?.()
          },
        })
      : undefined

    yield* ensure(function* () {
      if (cancelSub && !cancelSub.isClosed()) {
        cancelSub.unsubscribe()
      }
      ack()
    })

    const actionMeta = yield* service.actions._get(actionKey)
    let streamed = false

    /**
     * A lane is pumped INSIDE the action's own scope, through the sink — never after `invokeAction`
     * returns. The stream an action answers with is a scope-bound resource (a file read, a live
     * query): once the action's scopes unwind, draining it finds a handle that has already been
     * destroyed — a clean close with zero bytes, indistinguishable from an empty file. The gateway
     * learned this the hard way; a headless owner is the same edge one wire further out.
     */
    const sink: ResponseSink | undefined =
      cid !== undefined && producesLane(actionMeta)
        ? {
            *respond(stream) {
              streamed = true

              const draft = yield* ActionResponseContext.get()
              yield* respond(wireStream(toResponse(draft ?? emptyDraft(), [])))

              // what the answer holds, read off the OWNER's own declaration — the one authority
              // that is always present on this side of the wire
              const output = actionMeta?.wire.output.find(
                channel => channel.type === DataType.stream,
              )
              const bytes = output !== undefined && output.schema === undefined

              yield* pumpLane(
                nats,
                laneSubject(nats.prefix, cid, 'out', OUTPUT_LANE),
                stream as Stream<unknown, unknown>,
                bytes,
              )
            },
          }
        : undefined

    const work = function* () {
      const { streams, parts } = cid
        ? yield* captureInputLanes(cid, req)
        : { streams: [], parts: undefined }

      const invoke = () =>
        invokeAction({
          service,
          actionKey,
          params: req.params ?? [],
          streams,
          ...(parts === undefined ? {} : { parts }),
          ...(req.origin === undefined ? {} : { origin: req.origin }),
          ...(req.meta === undefined ? {} : { meta: req.meta }),
          ...(req.wire === undefined ? {} : { wire: req.wire }),
          contexts: req.contexts,
        })

      const outcome: Result<unknown, unknown> = yield* attempt(() =>
        sink ? ResponseSinkContext.with(sink, invoke) : invoke(),
      )

      if (!isSuccess(outcome)) {
        yield* respond(wireFailure(outcome))
        return
      }

      // the sink already took the lane and pumped it dry; anything else answers with a value
      if (!streamed) {
        yield* respond(wireSuccess(outcome.value as never))
      }
    }

    /**
     * Cancellation LOSES a race instead of halting this task.
     *
     * The previous shape — spawn the work, `yield*` the spawned task, `halt()` it from a watcher —
     * meant awaiting a task that got halted, and a halt propagates: it unwound this handler, and
     * with it the consume loop above, so ONE cancelled call silently stopped the owner serving
     * that address altogether. `race` contains the halt: the losing side is shut down inside the
     * race, and the winner's answer (or the cancel's failure) comes out as a plain value.
     */
    const interrupted = function* (): Operation<never> {
      yield* action<void>(resolve => {
        if (cancelled) {
          resolve()
          return () => {}
        }
        onCancel = resolve
        return () => {
          onCancel = undefined
        }
      }, 'nats:await-cancel')

      return yield* fail('cancelled', 'handler cancelled') as Operation<never>
    }

    const settled = yield* attempt(() => (cancelSub ? race([work(), interrupted()]) : work()))

    if (!isSuccess(settled)) {
      // the cancel fired, or the work broke before it could answer — either way, the reply (a
      // no-op if one already went out) and the ack still happen, and the caller learns why
      yield* respond(wireFailure(settled))

      if ((yield* Logger.context.get()) !== undefined) {
        yield* Logger.actions.child({ service: service.name, action: actionKey }, function* () {
          yield* Logger.actions.warn('nats:handler-cancelled', settled)
        })
      }
    }
  })
