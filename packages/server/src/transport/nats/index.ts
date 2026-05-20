import {
  Broker,
  CallContext,
  Codec,
  CoreErrors,
  TraceContext,
  Transport,
  registerTransport,
  useService,
} from 'server:core'
import type { BrokerDef, TransportDef } from 'server:core'
import { operation, until, useContext, useScope } from 'std:effect'
import { Logger } from 'std:logger'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { connect } from 'nats'
import type { NatsConnection, Subscription } from 'nats'

interface NatsTransportOptions extends TransportDef.Options {
  servers?: string | string[]
  subjectPrefix?: string
  queueGroup?: string
  requestTimeoutMs?: number
}

interface NatsTransportContext extends TransportDef.Context {
  connection: NatsConnection
  prefix: string
  queueGroup?: string
  requestTimeoutMs: number
  subscriptions: Subscription[]
}

const dispatchSubject = (prefix: string, serviceName: string, actionKey: string) =>
  `${prefix}.dispatch.${serviceName}.${actionKey}`

const emitSubject = (prefix: string, name: string) => `${prefix}.event.emit.${name}`

const broadcastSubject = (prefix: string, name: string) => `${prefix}.event.broadcast.${name}`

const dispatchLocally = function* (req: TransportDef.DispatchRequest) {
  const broker = yield* useContext(Broker)
  const { serviceName, actionKey, params = [], rawReq, traceContext } = req

  let service = broker.services.get(serviceName)
  let registeredName: string | undefined = service ? serviceName : undefined

  if (!service) {
    for (const [name, svc] of broker.services) {
      if (svc.name === serviceName) {
        service = svc
        registeredName = name
        break
      }
    }
  }

  if (!service || !registeredName) {
    return yield* fail(CoreErrors.NotFound, `service "${serviceName}" not registered locally`)
  }

  const action = (service.actions as Record<string, AnyType>)[actionKey]
  if (typeof action !== 'function') {
    return yield* fail(
      CoreErrors.NotFound,
      `action "${actionKey}" not found on service "${registeredName}"`,
    )
  }

  const callValue: BrokerDef.CallContext = {
    service,
    serviceName: registeredName,

    action: action as AnyType,
    actionKey,

    raw: { req: rawReq, res: undefined },
  }

  const hasLogger = (yield* Logger.context.get()) !== undefined

  const invoke = function* () {
    return yield* CallContext.with(callValue, function* () {
      const runBody = function* () {
        const result = yield* action(...params)
        return result === undefined ? callValue.raw.res : result
      }

      if (hasLogger) {
        return yield* Logger.actions.child(
          { service: registeredName as string, action: actionKey },
          runBody,
        )
      }

      return yield* runBody()
    })
  }

  if (traceContext) {
    return yield* TraceContext.with(traceContext, invoke)
  }

  return yield* invoke()
}

const NatsTransportImpl = Transport.implement<
  NatsTransportContext,
  unknown,
  [options?: NatsTransportOptions]
>({
  name: 'server/nats-transport',
  version: '0.0.0',
  *setup(options: NatsTransportOptions = {}) {
    const name = options.name ?? 'nats'
    const priority = options.priority ?? 10
    const next = options.next ?? false
    const prefix = options.subjectPrefix ?? 'ozaco'
    const requestTimeoutMs = options.requestTimeoutMs ?? 5000

    const connection = yield* until(
      connect({ servers: options.servers ?? 'nats://localhost:4222' }),
      'nats:connect',
    )

    const broker = yield* useContext(Broker)
    const scope = yield* useScope()

    const subscriptions: Subscription[] = []

    const dispatchSub = options.queueGroup
      ? connection.subscribe(`${prefix}.dispatch.>`, { queue: options.queueGroup })
      : connection.subscribe(`${prefix}.dispatch.>`)

    void (async () => {
      for await (const msg of dispatchSub) {
        const decoded = await scope.safeRun(() => Codec.actions.decode(msg.data))

        if (isFailure(decoded)) {
          if (msg.reply) {
            const replyPayload = await scope.safeRun(() =>
              Codec.actions.encode({
                _t: '__failure__',
                error: decoded.error,
                message: decoded.message,
                causes: decoded.causes,
              }),
            )
            if (!isFailure(replyPayload)) {
              msg.respond(replyPayload.value)
            }
          }
          continue
        }

        const result = await scope.safeRun(() =>
          dispatchLocally(decoded.value as TransportDef.DispatchRequest),
        )

        if (!msg.reply) {
          continue
        }

        const wire = isFailure(result)
          ? {
              _t: '__failure__',
              error: result.error,
              message: result.message,
              causes: result.causes,
            }
          : { _t: '__success__', value: result.value }

        const encoded = await scope.safeRun(() => Codec.actions.encode(wire))
        if (!isFailure(encoded)) {
          msg.respond(encoded.value)
        }
      }
    })()
    subscriptions.push(dispatchSub)

    const emitSub = connection.subscribe(`${prefix}.event.emit.>`)
    void (async () => {
      for await (const msg of emitSub) {
        const decoded = await scope.safeRun(() => Codec.actions.decode(msg.data))
        if (!isFailure(decoded)) {
          broker.bus.emit('event.emit', decoded.value as AnyType)
        }
      }
    })()
    subscriptions.push(emitSub)

    const broadcastSub = connection.subscribe(`${prefix}.event.broadcast.>`)
    void (async () => {
      for await (const msg of broadcastSub) {
        const decoded = await scope.safeRun(() => Codec.actions.decode(msg.data))
        if (!isFailure(decoded)) {
          broker.bus.emit('event.broadcast', decoded.value as AnyType)
        }
      }
    })()
    subscriptions.push(broadcastSub)

    yield* registerTransport(yield* useService())

    return {
      name,
      priority,
      next,

      connection,
      prefix,
      ...(options.queueGroup === undefined ? {} : { queueGroup: options.queueGroup }),
      requestTimeoutMs,
      subscriptions,
    }
  },
})

export const NatsTransport = NatsTransportImpl.build({
  dispatch: operation(function* (req: TransportDef.DispatchRequest) {
    const ctx = yield* useContext(NatsTransportImpl)
    const subject = dispatchSubject(ctx.prefix, req.serviceName, req.actionKey)

    const payload = yield* Codec.actions.encode(req)

    const reply = yield* until(
      ctx.connection.request(subject, payload, { timeout: ctx.requestTimeoutMs }),
      `nats:request ${subject}`,
    )

    const decoded = yield* Codec.actions.decode(reply.data)

    const wire = decoded as
      | { _t: '__success__'; value: unknown }
      | { _t: '__failure__'; error: unknown; message: string; causes?: string[] }

    if (wire._t === '__failure__') {
      return yield* fail(
        CoreErrors.TransportDispatch,
        wire.message,
        ...(wire.causes ?? []),
        String(wire.error),
      )
    }

    return wire.value
  }),

  emit: operation(function* (req: TransportDef.EventRequest) {
    const ctx = yield* useContext(NatsTransportImpl)
    const payload = yield* Codec.actions.encode(req)

    if (req.groups && req.groups.length > 0) {
      for (const group of req.groups) {
        ctx.connection.publish(`${ctx.prefix}.event.emit.${group}.${req.name}`, payload)
      }
      return
    }

    ctx.connection.publish(emitSubject(ctx.prefix, req.name), payload)
  }),

  broadcast: operation(function* (req: TransportDef.EventRequest) {
    const ctx = yield* useContext(NatsTransportImpl)
    const payload = yield* Codec.actions.encode(req)

    ctx.connection.publish(broadcastSubject(ctx.prefix, req.name), payload)
  }),
})
