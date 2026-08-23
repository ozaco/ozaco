/**
 * Live: the EVENT plane and a custom SOCKET — `notify` emits a named event (cluster-wide through
 * the carrier), `listen` relays events as SSE, and `/live/chat` is a hand-written socket route
 * (mounted by the app) that fans messages out to every connected client on this node.
 */
import type { EdgeDef } from '@ozaco/server'
import { action, Server, service, stream } from '@ozaco/server'
import type { Flow } from '@ozaco/std/effect'
import { z } from 'zod'

const Event = z.object({ name: z.string(), payload: z.unknown(), origin: z.string() })

export const live = service(
  'live',
  {
    notify: action.mutation(
      {
        input: z.object({ name: z.string().default('demo.ping'), payload: z.unknown().optional() }),
        output: z.object({ emitted: z.string() }),
        description: 'Emit an event every node hears (carrier event plane)',
      },
      function* ({ input, ctx }) {
        yield* ctx.emit(input.name, input.payload ?? { at: Date.now() })
        return { emitted: input.name }
      },
    ),
    listen: action.stream(
      {
        input: z.object({
          name: z.string().optional(),
          max: z.number().int().min(1).max(100).default(10),
        }),
        output: stream.sse(Event),
        description: 'Relay events (all, or one name) as server-sent events until `max`',
      },
      function* ({ input }) {
        const events: Flow<z.infer<typeof Event>, void> = {
          *[Symbol.iterator]() {
            const source = yield* Server.actions.events(input.name)
            let seen = 0
            return {
              *next() {
                if (seen >= input.max) {
                  return { done: true as const, value: undefined }
                }
                const step = yield* source.next()
                seen += 1
                return {
                  done: false as const,
                  value: {
                    name: step.value.name,
                    payload: step.value.payload,
                    origin: step.value.origin,
                  },
                }
              },
            }
          },
        }
        return events
      },
    ),
  },
  { version: '1.0.0', description: 'Events and sockets' },
)

/** The chat socket: every frame a client sends is fanned out to the others (this node). */
export const chatSocket = (): EdgeDef.SocketRoute => {
  const peers = new Set<EdgeDef.Socket>()

  return {
    path: '/live/chat',
    service: 'live',
    protocol: 'chat',
    description: 'send { text } — receive { from, text, at } from everyone on this node',
    *handler(socket) {
      peers.add(socket)
      const name = socket.headers['x-name'] ?? socket.id.slice(0, 6)

      try {
        yield* socket.send({ t: 'hello', id: socket.id, peers: peers.size })
        const messages = yield* socket.messages

        for (;;) {
          const step = yield* messages.next()

          if (step.done) {
            return
          }

          const text = String((step.value as { text?: unknown })?.text ?? '')

          for (const peer of peers) {
            yield* peer.send({ t: 'message', from: name, text, at: Date.now() })
          }
        }
      } finally {
        peers.delete(socket)
      }
    },
  }
}
