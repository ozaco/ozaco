/**
 * Live: the EVENT plane and a custom SOCKET — `notify` emits a named event (cluster-wide through
 * the carrier), `listen` relays events as SSE, and `chat` is a socket DECLARED IN THE SERVICE
 * (`action.socket`, mounted at `/live/chat`) that fans messages out to every client on this node.
 */
import type { EdgeDef } from '@ozaco/server'
import { action, Server, service, stream } from '@ozaco/server'
import { flowOf } from '@ozaco/std/effect'
import { z } from 'zod'

const ChatIn = z.object({ text: z.string() })

const ChatOut = z.union([
  z.object({ t: z.literal('hello'), id: z.string(), peers: z.number() }),
  z.object({ t: z.literal('message'), from: z.string(), text: z.string(), at: z.number() }),
])

/** everyone connected to this node's chat. */
const peers = new Set<EdgeDef.Socket<z.infer<typeof ChatIn>, z.infer<typeof ChatOut>>>()

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
      // ONE generator, no hand-rolled subscription object: `emit` sends the next event, a
      // plain return ends the stream (std's `flowOf`)
      function* ({ input }) {
        return flowOf<z.infer<typeof Event>>(function* (emit) {
          const source = yield* Server.actions.events(input.name)

          for (let seen = 0; seen < input.max; seen += 1) {
            const step = yield* source.next()
            yield* emit({
              name: step.value.name,
              payload: step.value.payload,
              origin: step.value.origin,
            })
          }
        })
      },
    ),
    chat: action.socket(
      {
        protocol: 'chat',
        description: 'send { text } — receive { from, text, at } from everyone on this node',

        // the frames are DECLARED: inbound is validated (a malformed one is dropped and
        // reported, never delivered), both sides type the handler and land in the manifest
        receives: ChatIn,
        sends: ChatOut,
      },
      function* (socket) {
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

            for (const peer of peers) {
              yield* peer.send({
                t: 'message',
                from: name,
                text: step.value.text,
                at: Date.now(),
              })
            }
          }
        } finally {
          peers.delete(socket)
        }
      },
    ),
  },
  { version: '1.0.0', description: 'Events and sockets' },
)
