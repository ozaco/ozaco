import { z } from 'zod'

import { actionEntry, socketEntry } from './internal/schema'

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
