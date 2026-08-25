import type { Flow, Operation, Queue } from 'std:effect'
import { createQueue, lift } from 'std:effect'
import type { AnyType } from 'std:shared'
import type { RtcDef } from 'std:webrtc'

// An in-memory RTCPeerConnection fake: two peers constructed from the SAME `createFakeRtc()`
// result link up once a full offer/answer exchange (matched by sdp strings) has been applied on
// both sides — exactly what the real negotiation dance produces over a signal. Channels open on
// link (or immediately when created while linked, mirroring in-band SCTP channels), `send`
// delivers to the twin channel on a microtask, and test controls (`sever`, `drain`, direct field
// writes) drive the failure paths deterministically.

const openPair = (owner: FakePeer, channel: FakeChannel) => {
  const other = owner.linked
  if (!other || channel.twin) {
    return
  }
  const twin = new FakeChannel(channel.label)
  channel.twin = twin
  twin.twin = channel
  queueMicrotask(() => {
    other.ondatachannel?.({ channel: twin })
    channel.open()
    twin.open()
  })
}

export interface FakeHub {
  peers: FakePeer[]
  /** When `true`, offers/answers no longer link — the connection can never (re)establish. */
  dead: boolean
}

export class FakeChannel implements RtcDef.ChannelLike {
  readyState: RtcDef.ChannelLike['readyState'] = 'connecting'
  /** what the impl "sees" on the wire — `getStats` reports these as data-channel stats. */
  messagesSent = 0
  bytesSent = 0
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  binaryType = 'arraybuffer'
  onopen: ((event: AnyType) => void) | null = null
  onmessage: ((event: { data: AnyType }) => void) | null = null
  onbufferedamountlow: ((event: AnyType) => void) | null = null
  onerror: ((event: AnyType) => void) | null = null
  onclose: ((event: AnyType) => void) | null = null
  twin: FakeChannel | undefined

  constructor(readonly label: string) {}

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== 'open') {
      throw new Error(`fake channel "${this.label}" is not open`)
    }
    this.messagesSent += 1
    this.bytesSent += typeof data === 'string' ? data.length : (data as ArrayBuffer).byteLength
    const twin = this.twin
    queueMicrotask(() => twin?.onmessage?.({ data }))
  }

  close(): void {
    const twin = this.twin
    if (this.readyState !== 'closed') {
      this.readyState = 'closed'
      queueMicrotask(() => this.onclose?.({}))
    }
    if (twin && twin.readyState !== 'closed') {
      twin.readyState = 'closed'
      queueMicrotask(() => twin.onclose?.({}))
    }
  }

  /** Test control: mark this channel open and fire `open`. */
  open(): void {
    this.readyState = 'open'
    queueMicrotask(() => this.onopen?.({}))
  }

  /** Test control: empty the buffer and fire `bufferedamountlow` (wakes parked senders). */
  drain(): void {
    this.bufferedAmount = 0
    queueMicrotask(() => this.onbufferedamountlow?.({}))
  }
}

export class FakeSender implements RtcDef.SenderLike {
  announced = false
  removed = false

  constructor(
    public track: RtcDef.TrackLike | null,
    readonly streams: RtcDef.StreamLike[],
  ) {}

  replaceTrack(track: RtcDef.TrackLike | null): Promise<void> {
    this.track = track
    return Promise.resolve()
  }
}

export class FakePeer implements RtcDef.PeerLike {
  connectionState = 'new'
  signalingState = 'stable'
  localDescription: RtcDef.DescriptionLike | null = null
  remoteDescription: RtcDef.DescriptionLike | null = null
  onnegotiationneeded: (() => void) | null = null
  onicecandidate: ((event: { candidate: RtcDef.CandidateLike | null }) => void) | null = null
  onconnectionstatechange: ((event?: AnyType) => void) | null = null
  ondatachannel: ((event: { channel: RtcDef.ChannelLike }) => void) | null = null
  ontrack: ((event: RtcDef.TrackEventLike) => void) | null = null
  channels: FakeChannel[] = []
  senders: FakeSender[] = []
  /** Candidates the negotiation actually delivered (asserted by the buffering test). */
  candidates: (RtcDef.CandidateLike | undefined)[] = []
  linked: FakePeer | undefined

  readonly hub: FakeHub
  readonly id: number
  private readonly mintSdp: (kind: string, id: number) => string
  private readonly tryLink: () => void
  private readonly announce: (peer: FakePeer) => void

  constructor(wiring: {
    hub: FakeHub
    id: number
    mintSdp: (kind: string, id: number) => string
    tryLink: () => void
    announce: (peer: FakePeer) => void
  }) {
    this.hub = wiring.hub
    this.id = wiring.id
    this.mintSdp = wiring.mintSdp
    this.tryLink = wiring.tryLink
    this.announce = wiring.announce
    this.hub.peers.push(this)
  }

  createOffer(options?: { iceRestart?: boolean }): Promise<RtcDef.DescriptionLike> {
    void options
    return Promise.resolve({ type: 'offer', sdp: this.mintSdp('offer', this.id) })
  }

  createAnswer(): Promise<RtcDef.DescriptionLike> {
    return Promise.resolve({ type: 'answer', sdp: this.mintSdp('answer', this.id) })
  }

  setLocalDescription(description?: RtcDef.DescriptionLike): Promise<void> {
    if (description?.type === 'rollback') {
      this.localDescription = null
      this.signalingState = 'stable'
      return Promise.resolve()
    }
    this.localDescription = description ?? null
    this.signalingState = description?.type === 'offer' ? 'have-local-offer' : 'stable'
    // trickle one candidate + end-of-candidates after every local description, like a real stack
    queueMicrotask(() => {
      this.onicecandidate?.({ candidate: { candidate: `cand:${this.id}` } })
      this.onicecandidate?.({ candidate: null })
    })
    this.tryLink()
    return Promise.resolve()
  }

  setRemoteDescription(description: RtcDef.DescriptionLike): Promise<void> {
    this.remoteDescription = description
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
    this.tryLink()
    return Promise.resolve()
  }

  addIceCandidate(candidate?: RtcDef.CandidateLike | null): Promise<void> {
    if (!this.remoteDescription) {
      // the plugin must buffer candidates until a remote description is applied
      return Promise.reject(new Error('addIceCandidate before setRemoteDescription'))
    }
    this.candidates.push(candidate ?? undefined)
    return Promise.resolve()
  }

  addTrack(track: RtcDef.TrackLike, ...streams: RtcDef.StreamLike[]): RtcDef.SenderLike {
    const sender = new FakeSender(track, streams)
    this.senders.push(sender)
    if (this.connectionState === 'connected') {
      this.announce(this) // in-band on an established link (the plugin still renegotiates)
    }
    return sender
  }

  removeTrack(sender: RtcDef.SenderLike): void {
    const fake = this.senders.find(candidate => candidate === sender)
    if (fake) {
      fake.removed = true
    }
  }

  createDataChannel(label: string, options?: RtcDef.ChannelInit): RtcDef.ChannelLike {
    void options
    const channel = new FakeChannel(label)
    this.channels.push(channel)
    if (this.connectionState === 'connected') {
      openPair(this, channel) // in-band: no renegotiation needed once linked
    }
    return channel
  }

  close(): void {
    // like the browser: a local close() fires no events on this side
    this.connectionState = 'closed'
    this.linked = undefined
  }

  /** A W3C-shaped statistics report: one transport, the selected candidate pair (host ↔ srflx),
   * one RTP stream each way, and every data channel with its exact wire counters. */
  getStats(): Promise<RtcDef.StatsReportLike> {
    const bytesSent = this.channels.reduce((total, channel) => total + channel.bytesSent, 0)
    const report = new Map<string, AnyType>([
      [
        'T1',
        {
          id: 'T1',
          type: 'transport',
          bytesSent,
          bytesReceived: 1024,
          selectedCandidatePairId: 'P1',
        },
      ],
      [
        'P1',
        {
          id: 'P1',
          type: 'candidate-pair',
          selected: true,
          nominated: true,
          state: 'succeeded',
          localCandidateId: 'L1',
          remoteCandidateId: 'R1',
          currentRoundTripTime: 0.012,
          availableOutgoingBitrate: 300_000,
          bytesSent,
          bytesReceived: 1024,
        },
      ],
      ['L1', { id: 'L1', type: 'local-candidate', candidateType: 'host' }],
      ['R1', { id: 'R1', type: 'remote-candidate', candidateType: 'srflx' }],
      [
        'V1',
        {
          id: 'V1',
          type: 'inbound-rtp',
          kind: 'video',
          bytesReceived: 2048,
          packetsReceived: 20,
          packetsLost: 1,
          jitter: 0.004,
          framesDecoded: 42,
          framesPerSecond: 24,
          frameWidth: 640,
          frameHeight: 480,
        },
      ],
      [
        'V2',
        {
          id: 'V2',
          type: 'outbound-rtp',
          kind: 'video',
          bytesSent: 4096,
          packetsSent: 30,
          framesSent: 60,
        },
      ],
      ...this.channels.map(
        (channel, index) =>
          [
            `D${index}`,
            {
              id: `D${index}`,
              type: 'data-channel',
              label: channel.label,
              state: channel.readyState,
              messagesSent: channel.messagesSent,
              bytesSent: channel.bytesSent,
              messagesReceived: channel.twin?.messagesSent ?? 0,
              bytesReceived: channel.twin?.bytesSent ?? 0,
            },
          ] as const,
      ),
    ])
    return Promise.resolve(report)
  }
}

/** A fake RTC "platform": every peer constructed from the returned Ctor shares one hub. Pass
 * `media: false` to simulate an implementation without a media surface (`addTrack` absent), or
 * `stats: false` for one that reports no statistics (`getStats` absent). */
export const createFakeRtc = (options?: { media?: boolean; stats?: boolean }) => {
  const hub: FakeHub = { peers: [], dead: false }
  let sdpCounter = 0
  let peerCounter = 0

  const mintSdp = (kind: string, id: number) => `${kind}:${id}:${(sdpCounter += 1)}`

  /** Deliver every not-yet-announced live sender of `peer` to its linked counterpart. */
  const announce = (peer: FakePeer) => {
    const other = peer.linked
    if (!other) {
      return
    }
    for (const sender of peer.senders) {
      if (sender.announced || sender.removed || !sender.track) {
        continue
      }
      sender.announced = true
      const track = sender.track
      const streams = sender.streams
      queueMicrotask(() => other.ontrack?.({ track, streams }))
    }
  }

  const tryLink = () => {
    if (hub.dead) {
      return
    }
    for (const x of hub.peers) {
      for (const y of hub.peers) {
        if (x === y || (x.connectionState === 'connected' && x.linked === y)) {
          continue
        }
        if (
          x.localDescription &&
          y.localDescription &&
          y.remoteDescription?.sdp === x.localDescription.sdp &&
          x.remoteDescription?.sdp === y.localDescription.sdp
        ) {
          x.linked = y
          y.linked = x
          x.signalingState = 'stable'
          y.signalingState = 'stable'
          x.connectionState = 'connected'
          y.connectionState = 'connected'
          queueMicrotask(() => {
            x.onconnectionstatechange?.()
            y.onconnectionstatechange?.()
          })
          for (const peer of [x, y]) {
            for (const channel of peer.channels) {
              openPair(peer, channel)
            }
            announce(peer)
          }
        }
      }
    }
  }

  const Ctor = function (this: unknown, configuration?: RtcDef.Configuration) {
    void configuration
    const peer = new FakePeer({ hub, id: (peerCounter += 1), mintSdp, tryLink, announce })
    if (options?.media === false) {
      ;(peer as AnyType).addTrack = undefined // an implementation without a media surface
    }
    if (options?.stats === false) {
      ;(peer as AnyType).getStats = undefined // an implementation with no statistics surface
    }
    return peer
  } as unknown as RtcDef.PeerCtor

  return { Ctor, hub }
}

/** Cut the connection: the given peers (all by default) drop to `failed` with cleared
 * descriptions, so only a fresh offer/answer round (an ICE restart) can relink them. Pass a
 * subset for a ONE-SIDED outage (only that side observes `failed`). */
export const sever = (hub: FakeHub, peers?: FakePeer[]) => {
  const affected = peers ?? hub.peers
  for (const peer of hub.peers) {
    peer.linked = undefined
    peer.localDescription = null
    peer.remoteDescription = null
    peer.signalingState = 'stable'
  }
  for (const peer of affected) {
    peer.connectionState = 'failed'
  }
  for (const peer of affected) {
    queueMicrotask(() => peer.onconnectionstatechange?.())
  }
}

/** Two cross-linked in-memory signals (A sends → B receives and vice versa); frames go through a
 * JSON round-trip like a real wire. The queues are returned for close-the-signal tests. */
export const createSignalPair = (): [
  RtcDef.SignalLike,
  RtcDef.SignalLike,
  { toA: Queue<unknown, unknown>; toB: Queue<unknown, unknown> },
] => {
  const toA = createQueue<unknown, unknown>()
  const toB = createQueue<unknown, unknown>()

  const make = (
    outgoing: Queue<unknown, unknown>,
    incoming: Queue<unknown, unknown>,
  ): RtcDef.SignalLike => ({
    send: lift((data: unknown) => {
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire IS json
      outgoing.add(JSON.parse(JSON.stringify(data)))
    }) as (data: unknown) => Operation<void>,
    messages: {
      *[Symbol.iterator]() {
        return incoming
      },
    } as Flow<unknown, unknown>,
  })

  return [make(toB, toA), make(toA, toB), { toA, toB }]
}
