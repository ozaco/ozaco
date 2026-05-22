import type { Operation } from 'std:effect'
import { operation } from 'std:effect'
import { asFailure, fail } from 'std:result'

import { CoreErrors, OTEL_RPC_SYSTEM, OtelAttrs, OtelSpanKind, OtelSpanStatusCode } from '../const'
import { Tracer } from '../definitions'
import type { BrokerDef } from '../types/broker'
import type { TracerDef } from '../types/tracer'

import { BrokerSettingContext } from './context'

interface CallSpanContext {
  broker: BrokerDef.Context
  serviceName: string
  actionKey: string
}

export const checkBrokerSettings = operation(function* () {
  const settings = (yield* BrokerSettingContext.get())!

  if (settings.destroying) {
    return yield* fail(CoreErrors.BrokerInternal, 'broker is being destroyed')
  }
  if (settings.paused) {
    return yield* fail(CoreErrors.BrokerPaused, `broker is paused: ${settings.paused}`)
  }
  if (!settings.started) {
    return yield* fail(CoreErrors.BrokerInternal, 'broker is not started')
  }
})

export const withCallSpan = function* <T>(
  ctx: CallSpanContext,
  body: (traceContext: TracerDef.SpanContext) => Operation<T, unknown>,
): Operation<T, unknown> {
  const span = yield* Tracer.actions.startSpan(`${ctx.serviceName}.${ctx.actionKey}`, {
    kind: OtelSpanKind.CLIENT,
    attributes: {
      [OtelAttrs.RPC_SYSTEM]: OTEL_RPC_SYSTEM,
      [OtelAttrs.RPC_SERVICE]: ctx.serviceName,
      [OtelAttrs.RPC_METHOD]: ctx.actionKey,
      [OtelAttrs.BROKER_NAME]: ctx.broker.name,
      [OtelAttrs.BROKER_NODE_ID]: ctx.broker.nodeId,
    },
  })

  const spanContextValue = yield* span.spanContext()

  try {
    return yield* body(spanContextValue)
  } catch (error) {
    const failure = asFailure(error)

    yield* span.recordException(failure)
    yield* span.setStatus({
      code: OtelSpanStatusCode.ERROR,
      message: failure.message,
      cause: failure.causes,
    })

    yield* failure

    return undefined as never
  } finally {
    yield* span.end()
  }
}
