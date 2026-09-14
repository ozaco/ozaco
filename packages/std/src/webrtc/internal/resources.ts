import type { Operation } from 'std:effect'
import { attempt, lift, operation, race, resource, sleep, until } from 'std:effect'
import { fail, isSuccess } from 'std:result'

import { RtcCauses, RtcErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { RtcDef } from '../types/rtc'

import { initOf, wrapChannel } from './channel'
import { CHANNEL_DEFAULTS } from './const'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** `entry.opened` bounded by `openTimeoutMs` (`0` disables the deadline). */
const awaitOpen = (entry: Helpers.ChannelEntry, label: string, timeoutMs: number) =>
  timeoutMs > 0
    ? race([
        entry.opened,
        operation(function* () {
          yield* sleep(timeoutMs)
          yield* fail(RtcErrors.Timeout, `channel "${label}" did not open within ${timeoutMs}ms`)
        })(),
      ])
    : entry.opened

/**
 * A local data channel is a RESOURCE in the CALLER's scope: it closes when that scope does, and
 * the session's registry force-ends it if the peer settles first. Under `reconnect` the handle
 * is continuous — the peer recreates it on every redialed generation.
 */
export const openChannel = (
  session: Helpers.Session,
  label: string,
  channelOptions?: RtcDef.ChannelOptions,
): Operation<RtcDef.Channel> =>
  resource(function* (provide) {
    const { options, counters, observe, localRecords } = session
    const merged = { ...options.channel, ...channelOptions }

    const generation = yield* session.awaitGeneration() // parks through a redial gap
    if (!generation || session.ended) {
      return yield* fail(RtcErrors.Channel, `peer is closed: cannot open "${label}"`)
    }

    let native: RtcDef.ChannelLike
    try {
      native = generation.pc.createDataChannel(label, initOf(merged))
    } catch (error) {
      return yield* fail(RtcErrors.Channel, `createDataChannel failed: ${messageOf(error)}`)
    }

    const entry = wrapChannel(native, merged, {
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      retain: session.retainLocal,
      observe,
    })
    const record: Helpers.LocalRecord = { entry, label, options: merged }
    localRecords.add(record)

    generation.kicked = true
    generation.negotiations.add({ kind: 'channel' }) // the first channel drives the offer

    try {
      yield* awaitOpen(entry, label, merged.openTimeoutMs ?? CHANNEL_DEFAULTS.openTimeoutMs)

      counters.channelsOpened += 1
      observe.record('channel', `out:${label}`)

      yield* provide(entry.handle)
    } finally {
      localRecords.delete(record)
      entry.end(true)
    }
  })

/**
 * An outgoing media track is a RESOURCE in the caller's scope AND a session-stable handle: the
 * peer re-adds it on every redialed generation until it is removed. Browser-first: the impl must
 * expose `addTrack` (else `rtc/unsupported`).
 */
export const openTrack = (
  session: Helpers.Session,
  track: RtcDef.TrackLike,
  streams: RtcDef.StreamLike[],
): Operation<RtcDef.Sender> =>
  resource(function* (provide) {
    const { counters, observe, trackRecords } = session

    const generation = yield* session.awaitGeneration() // parks through a redial gap
    if (!generation || session.ended) {
      return yield* fail(RtcErrors.Track, 'peer is closed: cannot add a track')
    }

    const { pc } = generation
    if (typeof pc.addTrack !== 'function') {
      return yield* fail(
        RtcErrors.Unsupported,
        'this implementation has no media surface (addTrack) — pass a media-capable `impl` to RtcClient.use',
      )
    }

    let sender: RtcDef.SenderLike
    try {
      sender = pc.addTrack(track, ...streams)
    } catch (error) {
      return yield* fail(RtcErrors.Track, `addTrack failed: ${messageOf(error)}`)
    }

    const record: Helpers.TrackRecord = { track, streams: [...streams], sender, removed: false }
    trackRecords.add(record)

    counters.tracksSent += 1
    observe.record('track', `out:${track.kind}`)

    generation.kicked = true
    generation.negotiations.add({ kind: 'track' }) // media always renegotiates

    const remove = () => {
      if (record.removed) {
        return
      }

      record.removed = true
      trackRecords.delete(record)

      const current = session.generation
      const active = record.sender
      record.sender = undefined

      if (session.ended || !current?.alive || !active) {
        return
      }

      if (typeof current.pc.removeTrack !== 'function') {
        return
      }

      try {
        current.pc.removeTrack(active)
      } catch {
        // the sender is already gone with its generation
      }

      current.kicked = true
      current.negotiations.add({ kind: 'track' })
    }

    const handle: RtcDef.Sender = {
      get native() {
        return record.sender
      },
      get track() {
        return record.track
      },

      replace: operation(function* (next: RtcDef.TrackLike | null) {
        if (record.removed || session.ended) {
          return yield* fail(RtcErrors.Track, 'sender is gone')
        }

        record.track = next // the next redialed generation adds THIS track

        const active = record.sender
        if (!active) {
          return // mid-redial gap — the rebind will pick the replacement up
        }

        if (typeof active.replaceTrack !== 'function') {
          return yield* fail(RtcErrors.Unsupported, 'this implementation has no replaceTrack')
        }

        const swapped = yield* attempt(() =>
          until(active.replaceTrack?.(next) ?? Promise.resolve()),
        )
        if (!isSuccess(swapped)) {
          return yield* fail(RtcErrors.Track, 'replaceTrack failed')
        }
      }, RtcCauses.ReplaceTrack),

      remove: lift(remove) as () => Operation<void>,
    }

    try {
      yield* provide(handle)
    } finally {
      remove()
    }
  })
