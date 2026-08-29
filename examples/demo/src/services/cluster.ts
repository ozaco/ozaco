/**
 * Cluster: what this node knows — its identity, presence members of every service, and a ping
 * that answers with the instance that served it (watch it round-robin over replicas).
 */
import { action, Server, service } from '@ozaco/server'
import { useContext } from '@ozaco/std/effect'
import { z } from 'zod'

const Member = z.object({
  instance: z.string(),
  serviceId: z.string(),
  version: z.string(),
  seenAt: z.number(),
  draining: z.boolean(),
})

export const cluster = service(
  'cluster',
  {
    ping: action.query(
      {
        output: z.object({ instance: z.string(), serviceId: z.string(), at: z.number() }),
        description: 'Answered by whichever node hosts `cluster`',
      },
      function* () {
        const kernel = yield* useContext(Server)
        return { instance: kernel.instance, serviceId: kernel.serviceId, at: Date.now() }
      },
    ),
    members: action.query(
      {
        output: z.record(z.string(), z.array(Member)),
        description: 'Presence: who hosts which service right now',
      },
      function* () {
        const kernel = yield* useContext(Server)
        const out: Record<string, z.infer<typeof Member>[]> = {}
        for (const name of kernel.registry.services.keys()) {
          out[name] = [...(yield* kernel.carrier!.actions.members(name))]
        }
        return out
      },
    ),
  },
  { version: '1.0.0', description: 'Node identity and presence' },
)
