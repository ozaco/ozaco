import type { Context } from 'std:effect'
import { createContext, markContextAsSnapshot } from 'std:effect'
import type { Protocol } from 'std:plugin'
import type { TraceDef } from 'std:trace'

import type { Helpers } from '../types/helpers'

/** Private state contexts of the core's own impls (never exported from the barrel). */
export const OutcomesMemoryRef =
  createContext<Helpers.OutcomesMemoryState>('server:outcomes/memory')
export const OutcomesDbRef = createContext<Helpers.OutcomesDbState>('server:outcomes/db')
export const LocalCarrierRef = createContext<Helpers.LocalCarrierState>('server:carrier/local')

/** The `ObserveExporter` installs a node inherited from an OUTER node's scope (set by
 * `createServer`): its fan-out skips them — a nested node never exports into, starts or flushes
 * another node's exporters. */
export const InheritedExporters = createContext<ReadonlySet<Protocol.Install> | null>(
  'server:observe-exporter.inherited',
  null,
)

/** While set, an `ObserveExporter` fan-out only COLLECTS the installs it would reach (runs none):
 * how `createServer` tells an outer node's exporters from its own. */
export const ExporterProbe = createContext<Protocol.Install[] | null>(
  'server:observe-exporter.probe',
  null,
)

/** The instrumentation scope of the USER spans opened inside the running dispatch (`ctx.span`,
 * `Server.actions.span`): its ozaco service, versioned — set by the dispatch span for its whole
 * extent (a streamed output's production included). Unset outside a dispatch (the node's name
 * then). A snapshot context: forks keep the dispatch they were created under. */
export const DispatchScope: Context<TraceDef.InstrumentationScope> = markContextAsSnapshot(
  createContext<TraceDef.InstrumentationScope>('server:dispatch-scope'),
)

/** While the server tracer forwards an exception record to the std Logger (`forwardException`):
 * the record's time — the failure's own — which the node's Logger hook (`markLoggedLines`)
 * stamps the entry with, so the line sorts where the failure happened, not where it settled. */
export const ForwardedAt: Context<number | null> = createContext<number | null>(
  'server:logger.forwarded-at',
  null,
)
