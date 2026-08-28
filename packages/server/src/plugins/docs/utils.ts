import { z } from 'zod'

/** The loose shape of an OZACO MANIFEST v1 — what a consumer may validate a fetched manifest
 * against (codegen, the panel, tests). */
export const manifestSchema = z.object({
  manifest: z.literal('ozaco/1'),
  name: z.string(),
  version: z.string(),
  instance: z.string(),
  services: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      description: z.string().optional(),
      actions: z.array(
        z.object({
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
        }),
      ),
    }),
  ),
  errors: z.record(z.string(), z.number()),
  sockets: z
    .array(
      z.object({
        path: z.string(),
        service: z.string().nullable(),
        protocol: z.string().nullable(),
        description: z.string().nullable(),

        /** opening-frame defaults (realtime documents `{ cursor: 0 }` — the start of the set). */
        defaults: z.record(z.string(), z.unknown()).nullable().optional(),

        /** the declared frame schemas, when the action gave them. */
        receives: z.record(z.string(), z.unknown()).nullable().optional(),
        sends: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    )
    .optional(),
})
