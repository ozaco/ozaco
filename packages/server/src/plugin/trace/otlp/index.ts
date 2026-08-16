/**
 * `server:plugin/trace/otlp` — the OTLP/HTTP JSON `TraceExporter`: encodes span snapshots with
 * the protobuf-JSON mapping and POSTs them to a collector (`/v1/traces`) through the `std:fetch`
 * plugin. Install alongside `FetchClient` and `DefaultTracer`.
 */
export * from './definition'
export type * from './types'
