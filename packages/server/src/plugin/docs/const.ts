import { z } from 'zod'

/**
 * OZACO MANIFEST v1 — the typed, WebSocket-capable API document standard of this stack (the
 * OpenAPI replacement and the client codegen source). The internal compiler generates the
 * document; {@link manifestSchema} validates it — a generated document that fails the schema is
 * a bug, never something to serve.
 */

/** JSON Schema documents travel as opaque objects; `{ declared: true }` marks non-zod schemas. */
const schemaDoc = z.record(z.string(), z.unknown())

const statusEntry = z.object({ status: z.number().int() })

const routeDoc = z.object({
  method: z.string(),
  path: z.string(),
  sse: z.boolean().optional(),
})

const functionDoc = z.object({
  kind: z.enum(['query', 'mutation', 'action', 'stream']),
  title: z.string().optional(),
  description: z.string().optional(),
  route: routeDoc.optional(),
  args: schemaDoc.optional(),
  returns: schemaDoc.optional(),
  channels: z.object({
    input: z.array(z.enum(['value', 'stream', 'chunks', 'parts', 'socket'])),
    output: z.array(z.enum(['value', 'stream', 'chunks', 'parts', 'socket'])),
  }),
  errors: z.record(z.string(), statusEntry).optional(),
  tags: z.array(z.string()).optional(),
})

const realtimeDoc = z.object({
  path: z.string(),
  /** The service also serves the SSE flavor at `GET <path>/sse?fn=&args=&since=`. */
  sse: z.literal(true).optional(),
  client: z.object({ watch: schemaDoc, unwatch: schemaDoc }),
  server: z.object({ sync: schemaDoc, delta: schemaDoc, reset: schemaDoc, error: schemaDoc }),
})

const serviceDoc = z.object({
  version: z.string(),
  description: z.string().optional(),
  prefix: z.string(),
  functions: z.record(z.string(), functionDoc),
  events: z.record(z.string(), schemaDoc).optional(),
  realtime: realtimeDoc.optional(),
})

/** The manifest standard is itself typed and validated — parse every generated document. */
export const manifestSchema = z.object({
  ozaco: z.literal('1.0'),
  app: z.object({
    title: z.string(),
    version: z.string(),
    description: z.string().optional(),
  }),
  auth: z.object({ bearer: z.literal(true) }).optional(),
  errors: z.record(z.string(), statusEntry),
  services: z.record(z.string(), serviceDoc),
})
