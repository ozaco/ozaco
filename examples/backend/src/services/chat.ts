import { Gateway } from 'server:core'
import { IO } from 'std:io'

// A socket.io-style chat over `Gateway.actions.listen` — registered WITHOUT defineAction/mount. It
// showcases the gateway real-time layer end to end:
//   • `listen(path, handlers)`   — a raw WS endpoint, no action ceremony
//   • `on: { … }`                — event routing (client sends `{ event, … }`)
//   • `message`                  — the raw catch-all for frames with no matching event
//   • the `socket` handle        — `send` / `join` / `leave` / `toRoom` / `broadcast`
//   • `Gateway.actions.emit(id)` — a direct message to ONE socket by id (see `on.dm`)
//   • server push               — `broadcast` fired from open/close (outside any request)
//   • `IO.actions.uuid()`        — a per-connection session id
//   • `IO.actions.ulid()`        — sortable, monotonic message ids
//
// Try it (server running on :3000):
//   websocat ws://127.0.0.1:3000/chat
//   > {"event":"join","room":"general"}
//   > {"event":"say","room":"general","text":"hello!"}

let online = 0

export const mountChat = () =>
  Gateway.actions.listen('/chat', {
    *open(socket) {
      online += 1
      const session = yield* IO.actions.uuid() // per-connection id via IO (IO-first)
      yield* socket.join('lobby')
      yield* socket.send({ event: 'welcome', id: socket.id, session })
      yield* socket.broadcast({ event: 'presence', online }) // push to everyone, no request in scope
    },

    on: {
      *join(socket, msg) {
        const room = String(msg.room ?? 'lobby')
        yield* socket.join(room)
        yield* socket.toRoom(room, { event: 'joined', who: socket.id, room })
      },

      *leave(socket, msg) {
        const room = String(msg.room ?? 'lobby')
        yield* socket.leave(room)
        yield* socket.toRoom(room, { event: 'left', who: socket.id, room })
      },

      *say(socket, msg) {
        const room = String(msg.room ?? 'lobby')
        const id = yield* IO.actions.ulid({ bucket: 'msg_' }) // sortable message id
        yield* socket.toRoom(room, {
          event: 'message',
          id,
          from: socket.id,
          text: String(msg.text ?? ''),
        })
      },

      *dm(socket, msg) {
        // a private message to ONE socket by id — server push targeted with Gateway.actions.emit
        yield* Gateway.actions.emit(String(msg.to ?? ''), {
          event: 'dm',
          from: socket.id,
          text: String(msg.text ?? ''),
        })
      },
    },

    *message(socket, msg) {
      // any frame without a recognised `event` lands here
      yield* socket.send({
        event: 'error',
        reason: "unknown event — use { event: 'join' | 'leave' | 'say', … }",
        got: msg,
      })
    },

    *close(socket) {
      online = Math.max(0, online - 1)
      yield* socket.broadcast({ event: 'presence', online })
    },
  })
