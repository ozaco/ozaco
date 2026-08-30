import { z } from 'zod'

const socketEntry = z.object({
  id: z.string(),
  service: z.string().nullable(),
  action: z.string().nullable(),
  kind: z.literal('socket'),
  path: z.string(),
  protocol: z.string().nullable(),
  description: z.string().nullable(),

  /** how the socket authorizes: an upgrade header, or the first in-band `auth` frame. */
  authorize: z.enum(['upgrade', 'first-frame']),

  /** opening-frame defaults (realtime documents `{ cursor: 0 }` — the start of the set). */
  defaults: z.record(z.string(), z.unknown()).nullable().optional(),

  /** the declared frame schemas, when the action gave them. */
  receives: z.record(z.string(), z.unknown()).nullable().optional(),
  sends: z.record(z.string(), z.unknown()).nullable().optional(),
})

const actionEntry = z.object({
  id: z.string(),
  service: z.string(),
  action: z.string(),
  kind: z.enum(['query', 'mutation', 'action', 'stream']),
  route: z.object({ method: z.string(), path: z.string() }),
  input: z.object({
    plane: z.string(),
    brand: z.string().nullable(),
    contentType: z.string().nullable(),
  }),
  output: z.object({
    plane: z.string(),
    brand: z.string().nullable(),
    contentType: z.string().nullable(),
  }),
  auth: z.object({
    kind: z.enum([
      'open',
      'authenticated',
      'user',
      'service',
      'roles',
      'requirements',
      'predicate',
    ]),
    roles: z.array(z.string()).optional(),
    permissions: z.array(z.string()).optional(),
  }),
  docs: z.record(z.string(), z.unknown()).nullable().optional(),
})

/** The loose shape of an OZACO MANIFEST v2 — what a consumer may validate a fetched manifest
 * against (codegen, the panel, tests). Services carry ONE unified entry list: callable actions
 * and this service's sockets (`kind: 'socket'`). */
export const manifestSchema = z.object({
  manifest: z.literal('ozaco/2'),
  name: z.string(),
  version: z.string(),
  instance: z.string(),
  services: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      description: z.string().optional(),
      actions: z.array(z.union([actionEntry, socketEntry])),
      errors: z.record(z.string(), z.number()),
    }),
  ),
  errors: z.record(z.string(), z.number()),
  edge: z.object({ sockets: z.array(socketEntry) }),
})
