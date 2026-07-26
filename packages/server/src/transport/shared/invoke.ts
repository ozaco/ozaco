import type { Carried, Request, Service, Source, TransportDef } from 'server:core'
import { DataType, EXTERNAL_ORIGIN, INTERNAL_ORIGIN, invokeLocal } from 'server:core'
import type { Stream } from 'std:effect'
import { operation } from 'std:effect'

export interface InvokeArgs {
  service: Service
  actionKey: string
  params: unknown[]
  streams: Stream<unknown, void>[]
  /** a multipart body rebuilt from its lane — at most one per call, like the source it becomes */
  parts?: Stream<Source.Part, unknown>

  /** as it crossed the wire; mapped back to the symbol here, in one place, in both directions */
  origin?: 'internal' | 'external'
  meta?: Record<string, string>
  wire?: { sends: Carried[]; receives: Carried[] }

  contexts?: TransportDef.DispatchContexts | undefined
}

/**
 * Rebuild the {@link Request} a carrier took apart, and run it.
 *
 * A thin seam over `invokeLocal`, which is the ONE invoker every carrier shares. This exists only
 * because a wire cannot carry a symbol or a `Stream`, so `origin` arrives as a string and the lanes
 * arrive as separate subscriptions — both are put back here rather than in each carrier, which is
 * where the mapping used to be forgotten.
 */
export const invokeAction = operation(function* (args: InvokeArgs) {
  const request: Request = {
    origin: args.origin === 'external' ? EXTERNAL_ORIGIN : INTERNAL_ORIGIN,
    service: args.service.name,
    path: args.actionKey,
    meta: args.meta ?? {},
    sources: [
      ...args.params.map(value => ({ type: DataType.normal, value }) as const),
      ...args.streams.map(stream => ({ type: DataType.stream, stream }) as const),
      ...(args.parts === undefined
        ? []
        : [{ type: DataType.multistream, parts: args.parts } as const]),
    ],
    ...(args.wire === undefined ? {} : { wire: args.wire }),
  }

  return yield* invokeLocal(args.service, request, args.contexts)
})
