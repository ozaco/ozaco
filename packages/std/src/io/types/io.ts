import type { Flow, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

/**
 * `std:io` — the platform IO protocol. `IO` is the protocol (routed `IO.actions.*`), `BunIO` /
 * `NodeIO` / `WebIO` its implementations (one per scope). Every shape an action takes or returns
 * lives in this namespace; `Actions` is the contract itself.
 */
export type IODef = Plugin<AnyType, unknown[], IODef.Actions>

export namespace IODef {
  export type PathLike = string | URL

  /** The close value an IO byte flow settles with: `true` on a clean end, or the failure that interrupted it. */
  export type FlowClose = true | Result.Failure<unknown>

  export type HashAlgorithm = 'SHA-256' | 'SHA-384' | 'SHA-512'

  export interface IOStat {
    isFile: boolean
    isDirectory: boolean
    isSymlink: boolean
    size: number
    mtime: Date | null
    atime: Date | null
    birthtime: Date | null
  }

  export interface WalkEntry {
    path: string
    name: string
    isFile: boolean
    isDirectory: boolean
    isSymlink: boolean
  }

  export interface NodeReadableLike {
    on(event: string, listener: (...args: AnyType[]) => void): this
    off(event: string, listener: (...args: AnyType[]) => void): this
    destroy?(error?: Error): this
  }

  export interface WebReadableLike {
    read(): Promise<ReadableStreamReadResult<Uint8Array>>
    cancel(reason?: AnyType): Promise<void>
    releaseLock(): void
  }

  export type ReadableLike = NodeReadableLike | WebReadableLike

  export interface WritableLike {
    write(chunk: Uint8Array): boolean
    end(): this
    destroy?(error?: Error): this
    on(event: string, listener: (...args: AnyType[]) => void): this
    once(event: string, listener: (...args: AnyType[]) => void): this
    off(event: string, listener: (...args: AnyType[]) => void): this
  }

  /** Options for {@link IODef.Actions.walk}. */
  export interface WalkOptions {
    /** Which entries to collect: `IO_FLAGS.files`, `IO_FLAGS.dirs` or both (the default). Add
     * `IO_FLAGS.followSymlinks` to `stat` instead of `lstat`, so a symlink to a directory is reported
     * as a directory and descended into (otherwise it is a leaf `isSymlink` entry). */
    flags?: number | undefined
    /** Deepest directory level to descend into, counting `root`'s direct children as depth `0` — so
     * `maxDepth: 0` lists only the root's own entries. Default: unbounded. */
    maxDepth?: number | undefined
    /** Keep only entries whose full path matches at least one pattern. Filters what is collected, not
     * what is traversed: a non-matching directory is still descended into. */
    match?: RegExp[] | undefined
    /** Prune entries whose full path matches any pattern: they are neither collected nor (for a
     * directory) descended into. Applied before `match`. */
    skip?: RegExp[] | undefined
  }

  /** A filesystem change reported by {@link IODef.Actions.watch}. */
  export interface WatchEvent {
    /** `'rename'` for create/delete/move, `'change'` for content edits (as `fs.watch` reports). */
    type: 'rename' | 'change'
    /** The affected entry name relative to the watched path, or `null` when the platform omits it. */
    path: string | null
  }

  /** Options for {@link IODef.Actions.watch}. */
  export interface WatchOptions {
    /** Watch nested directories too (platform support varies). Defaults to `false`. */
    recursive?: boolean | undefined
  }

  /** Options for {@link IODef.Actions.ulid}. */
  export interface UlidOptions {
    /** Quantize the timestamp to this many ms (`floor(now/window)*window`); default `1` (per-ms). */
    window?: number | undefined
    /** Total id length EXCLUDING `bucket` (10 timestamp chars + `length - 10` random); default `26`.
     * Not validated: the random tail is at least 1 char, so any `length <= 10` yields an 11-char id. */
    length?: number | undefined
    /** Fixed prefix segment (namespace/shard tag); ids from different buckets never collide. */
    bucket?: string | undefined
  }

  /** Options for {@link IODef.Actions.hlc}. */
  export interface HlcOptions {
    /** This node's identity — exactly 8 Crockford base32 characters (`0-9 A-H J K M N P-T V-Z`). */
    origin: string
  }

  /** Options for {@link IODef.Actions.observeHlc}. */
  export interface ObserveHlcOptions {
    /** A remote timestamp further ahead of the local clock than this is NOT adopted (a misconfigured
     * peer clock must not drag the whole cluster into the future). Default `60_000`. */
    maxDriftMs?: number | undefined
  }

  /** The decoded parts of an HLC token. */
  export interface Hlc {
    /** Hybrid-logical milliseconds — ordering only, not wall time. */
    ts: number
    /** Same-millisecond sequence (0-based). */
    counter: number
    /** The minting node, 8 Crockford characters. */
    origin: string
  }

  /** Options shared by {@link IODef.Actions.exec} and {@link IODef.Actions.spawn}. */
  export interface ProcessOptions {
    /** Working directory for the child. Defaults to the parent's cwd. */
    cwd?: PathLike
    /** Environment overrides, layered over the parent's `process.env` (set a key to `undefined` to drop it). */
    env?: Record<string, string | undefined>
  }

  /** Options for {@link IODef.Actions.exec}. */
  export interface ExecOptions extends ProcessOptions {
    /** Bytes (or text) written to the child's stdin, which is then closed. */
    stdin?: Uint8Array | string
    /** Kill the child after this many milliseconds. */
    timeout?: number
  }

  /** Options for {@link IODef.Actions.spawn}. */
  export type SpawnOptions = ProcessOptions

  /** The exit status of a child process. */
  export interface ProcessStatus {
    /** Exit code, or `null` when the process was terminated by a signal. */
    code: number | null
    /** Terminating signal name (e.g. `'SIGTERM'`), or `null` when it exited on its own. */
    signal: string | null
    /** `true` when the process exited cleanly (`code === 0` and no signal). */
    success: boolean
  }

  /** The buffered result of running a command to completion via {@link IODef.Actions.exec}. */
  export interface ExecResult extends ProcessStatus {
    stdout: Uint8Array
    stderr: Uint8Array
  }

  /** A handle to a child process spawned via {@link IODef.Actions.spawn}. */
  export interface ProcessHandle {
    /** OS process id (`-1` if the process never started). */
    readonly pid: number
    /** The child's stdout as a byte flow. */
    readonly stdout: Flow<Uint8Array, FlowClose>
    /** The child's stderr as a byte flow. */
    readonly stderr: Flow<Uint8Array, FlowClose>
    /** Resolve with the exit status once the process ends. */
    exited: () => Operation<ProcessStatus>
    /** Write a chunk to the child's stdin. */
    write: (chunk: Uint8Array | string) => Operation<void>
    /** Close the child's stdin. */
    closeStdin: () => Operation<void>
    /** Send a termination signal (default `SIGTERM`). */
    kill: (signal?: number | string) => Operation<void>
  }

  /** An Ed25519 key pair (DER bytes: public = SPKI, private = PKCS8), from {@link IODef.Actions.generateKeyPair}. */
  export interface KeyPair {
    publicKey: Uint8Array
    privateKey: Uint8Array
  }

  /** A single network interface address, as reported by {@link IODef.Actions.ip}. */
  export interface NetworkInterface {
    /** Interface name (e.g. `en0`, `lo0`, `eth0`). */
    name: string
    address: string
    family: 'IPv4' | 'IPv6'
    /** `true` for loopback / internal interfaces. */
    internal: boolean
    mac: string
    netmask: string
    /** Address in CIDR notation (e.g. `192.168.1.5/24`), or `null` if unavailable. */
    cidr: string | null
  }

  /** Options for {@link IODef.Actions.tcpListen}. */
  export interface TcpListenOptions {
    port: number
    /** Interface to bind. Defaults to `0.0.0.0`. */
    hostname?: string
    /** Enable kernel-level `SO_REUSEPORT` load balancing across processes. */
    reusePort?: boolean
  }

  /** Options for {@link IODef.Actions.tcpConnect}. */
  export interface TcpConnectOptions {
    port: number
    /** Host to connect to. Defaults to `127.0.0.1`. */
    hostname?: string
  }

  /** A bidirectional TCP byte channel (an accepted connection or a client socket). */
  export interface TcpSocket {
    readonly remoteAddress: string
    readonly remotePort: number
    readonly localPort: number
    /** Inbound bytes; the close value is `true` on a clean end or the failure that interrupted it. */
    data: Flow<Uint8Array, FlowClose>
    /** Write a chunk, resolving once it has been flushed (honors backpressure). */
    write: (chunk: Uint8Array | string) => Operation<void>
    /** Half-close the socket's write side and tear it down. */
    close: () => Operation<void>
  }

  /** A per-connection handler; runs as a child of the scope that called {@link IODef.Actions.tcpListen}. */
  export type TcpHandler = (socket: TcpSocket) => Operation<void>

  /** A handle to a listening TCP server (see {@link IODef.Actions.tcpListen}). */
  export interface TcpServer {
    readonly port: number
    readonly hostname: string
    /** Stop accepting connections and shut the server down. */
    close: () => Operation<void>
  }

  /** Options for {@link IODef.Actions.udpBind}. */
  export interface UdpBindOptions {
    /** Local port to bind. Omit or `0` for an ephemeral port. */
    port?: number
    /** Interface to bind. */
    hostname?: string
  }

  /** A single received UDP datagram plus its sender. */
  export interface UdpDatagram {
    data: Uint8Array
    address: string
    port: number
  }

  /** A handle to a bound UDP socket (see {@link IODef.Actions.udpBind}). */
  export interface UdpSocket {
    readonly port: number
    /** Inbound datagrams, buffered from bind time. */
    messages: Flow<UdpDatagram, FlowClose>
    /** Send a datagram to an explicit destination. */
    send: (data: Uint8Array | string, port: number, address: string) => Operation<void>
    /** Close the socket. */
    close: () => Operation<void>
  }

  // --- S3 (object storage) — Bun's native S3Client on BunIO, a SigV4-over-fetch client on NodeIO ---

  /** Connection + credentials for an S3 client. Any field may be omitted to fall back to the env:
   * Bun's `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_SESSION_TOKEN` / `S3_REGION` /
   * `S3_BUCKET` / `S3_ENDPOINT` first, then (NodeIO's fetch client only) the AWS SDK names
   * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION` /
   * `AWS_ENDPOINT_URL_S3`; the fetch client also defaults `region` to `us-east-1`. */
  export interface S3Options {
    readonly accessKeyId?: string
    readonly secretAccessKey?: string
    readonly sessionToken?: string
    readonly region?: string
    readonly bucket?: string
    readonly endpoint?: string
    /** Canned ACL applied to writes (e.g. `'public-read'`). */
    readonly acl?: string
    /** Part size in bytes for STREAMING writes (a `ReadableStream` body goes up as a multipart
     * upload, one part per `partSize` bytes; default 5 MiB — S3's minimum, MinIO accepts smaller). */
    readonly partSize?: number
  }

  /** What a write accepts: whole values, or a `ReadableStream` that is uploaded as it is read (multipart,
   * `partSize` bytes buffered at a time). Adapt an effect Flow with `IO.actions.toReadable`. */
  export type S3Body = Uint8Array | string | Blob | ReadableStream<Uint8Array>

  /** Object metadata (from `stat`). */
  export interface S3Stat {
    readonly size: number
    readonly etag?: string | undefined
    readonly lastModified?: Date | undefined
    readonly type?: string | undefined
  }

  /** Options for a presigned URL. */
  export interface S3PresignOptions {
    /** Seconds the URL stays valid. */
    readonly expiresIn?: number
    /** The HTTP method the URL authorizes (default `'GET'`). */
    readonly method?: 'GET' | 'PUT' | 'DELETE' | 'HEAD'
    readonly acl?: string
    readonly type?: string
  }

  export interface S3ListOptions {
    readonly prefix?: string
    readonly maxKeys?: number
    readonly continuationToken?: string
    readonly startAfter?: string
  }

  export interface S3ObjectInfo {
    readonly key: string
    readonly size?: number | undefined
    readonly lastModified?: Date | undefined
    readonly etag?: string | undefined
  }

  export interface S3ListResult {
    readonly contents: readonly S3ObjectInfo[]
    readonly truncated: boolean
    readonly continuationToken?: string | undefined
  }

  /** A handle to one S3 object (mirrors Bun's `S3File`, effect-native). Operations are lazy — nothing
   * hits the network until you call one. */
  export interface S3File {
    readonly key: string
    text: () => Operation<string>
    json: <T = unknown>() => Operation<T>
    bytes: () => Operation<Uint8Array>
    arrayBuffer: () => Operation<ArrayBuffer>
    /** The object's byte stream, read end to end as it arrives (a platform `ReadableStream`; adapt
     * it with `IO.actions.fromReadable`). */
    stream: () => Operation<ReadableStream<Uint8Array>>
    /** Upload/overwrite the object; resolves to the number of bytes written. A `ReadableStream`
     * body streams end to end (multipart upload, bounded memory). */
    write: (data: S3Body) => Operation<number>
    exists: () => Operation<boolean>
    delete: () => Operation<void>
    stat: () => Operation<S3Stat>
    /** A presigned URL for this object (default `GET`). */
    presign: (options?: S3PresignOptions) => Operation<string>
  }

  /** An S3 client bound to a bucket/credentials — `IO.actions.s3(options)`. BunIO uses Bun's built-in
   * `S3Client`; NodeIO uses a dependency-free SigV4-over-`fetch` client (path-style URLs). Only WebIO
   * has no client: the handle is still constructible there, but every operation fails
   * `IOErrors.Unsupported`. */
  export interface S3Client {
    /** A handle to one object. */
    file: (key: string) => S3File
    read: (key: string) => Operation<Uint8Array>
    write: (key: string, data: S3Body) => Operation<number>
    exists: (key: string) => Operation<boolean>
    delete: (key: string) => Operation<void>
    stat: (key: string) => Operation<S3Stat>
    list: (options?: S3ListOptions) => Operation<S3ListResult>
    presign: (key: string, options?: S3PresignOptions) => Operation<string>
  }

  export type Actions = {
    env: <R extends Record<string, unknown>, K extends keyof R = never>(
      mapper: (data: Record<string, string | undefined>) => R,
      optional?: readonly K[],
    ) => Operation<{ [P in keyof R]: P extends K ? R[P] : NonNullable<R[P]> }>

    /** `length` cryptographically random bytes. BunIO/WebIO use WebCrypto `getRandomValues`, which
     * the spec caps at 65536 bytes per call (browsers throw `QuotaExceededError` above that; Bun did
     * not in a probe); NodeIO uses `node:crypto.randomBytes` with no such cap. */
    randomBytes: (length: number) => Operation<Uint8Array>
    /** Generate a ULID — lexicographically sortable, monotonic within a `window`. See {@link UlidOptions}. */
    ulid: (options?: UlidOptions) => Operation<string>
    /** Generate an RFC 4122 version-4 (random) UUID string. */
    uuid: () => Operation<string>
    /** Mint a hybrid-logical-clock token: 22 Crockford chars = 48-bit ms time | 16-bit counter |
     * 40-bit origin. Lexicographic order = causal order; decodable via {@link decodeHlc}. State is
     * kept per origin; `ts = max(now, observed floor, last)`, same-ms mints bump the counter. */
    hlc: (options: HlcOptions) => Operation<string>
    /** Decode a token into `{ ts, counter, origin }`; fails `hlc-invalid` on malformed input. */
    decodeHlc: (token: string) => Operation<Hlc>
    /** The HLC receive rule: pull the local clock floor up to a remote token's time (bounded by
     * `maxDriftMs`). Resolves `true` when adopted, `false` when rejected as drift. */
    observeHlc: (token: string, options?: ObserveHlcOptions) => Operation<boolean>
    hmac: (algorithm: HashAlgorithm, key: Uint8Array, data: Uint8Array) => Operation<Uint8Array>
    hash: (algorithm: HashAlgorithm, data: Uint8Array) => Operation<Uint8Array>

    /** Encrypt with a secret (AES-256-GCM, key derived from the secret via scrypt). Reversible via {@link decrypt}. */
    encrypt: (data: Uint8Array | string, secret: string) => Operation<Uint8Array>
    /** Decrypt what {@link encrypt} produced; fails on a wrong secret or tampered data. */
    decrypt: (data: Uint8Array, secret: string) => Operation<Uint8Array>

    /** Generate an Ed25519 key pair for {@link sign} / {@link verify}. */
    generateKeyPair: () => Operation<KeyPair>
    /** Sign data with an Ed25519 private key (from {@link generateKeyPair}); returns a 64-byte signature. */
    sign: (data: Uint8Array | string, privateKey: Uint8Array) => Operation<Uint8Array>
    /** Verify an Ed25519 signature against the public key; `true` if valid, `false` if not. */
    verify: (
      data: Uint8Array | string,
      signature: Uint8Array,
      publicKey: Uint8Array,
    ) => Operation<boolean>

    fromReadable: (
      target: ReadableLike,
      options?: { destroy?: boolean },
    ) => Flow<Uint8Array, FlowClose>
    toReadable: (
      source: Flow<Uint8Array, unknown>,
    ) => Operation<{ readable: ReadableStream<Uint8Array>; pump: Operation<void> }>
    readFlow: (path: PathLike) => Flow<Uint8Array, FlowClose>
    writeFlow: (
      path: PathLike,
      source: Flow<Uint8Array, unknown>,
      options?: {
        flags?: number
      },
    ) => Operation<void>
    read: (path: PathLike) => Operation<Uint8Array>
    readText: (path: PathLike, encoding?: string) => Operation<string>
    write: (
      path: PathLike,
      data: Uint8Array | string,
      options?: {
        flags?: number
      },
    ) => Operation<void>
    append: (path: PathLike, data: Uint8Array) => Operation<void>
    copy: (
      src: PathLike,
      dest: PathLike,
      options?: {
        flags?: number
      },
    ) => Operation<void>
    rename: (
      src: PathLike,
      dest: PathLike,
      options?: {
        flags?: number
      },
    ) => Operation<void>
    rm: (
      path: PathLike,
      options?: {
        recursive?: boolean
        force?: boolean
      },
    ) => Operation<void>
    exists: (path: PathLike) => Operation<boolean>
    stat: (path: PathLike) => Operation<IOStat>
    lstat: (path: PathLike) => Operation<IOStat>
    readdir: (
      path: PathLike,
      options?: {
        recursive?: boolean
      },
    ) => Operation<string[]>
    ensureDir: (path: PathLike) => Operation<void>
    ensureFile: (path: PathLike) => Operation<void>
    emptyDir: (path: PathLike) => Operation<void>
    walk: (root: PathLike, options?: WalkOptions) => Operation<WalkEntry[]>
    /** Watch a file or directory, streaming {@link WatchEvent}s until the flow is torn down. Prefers a
     * Watchman subscription (optional `fb-watchman` dependency + a reachable daemon; always recursive
     * for a directory, so `recursive` is ignored there) and falls back to `fsPromises.watch`
     * (event-based, `recursive` honored where the platform supports it). Set the env var
     * `STD_WATCHMAN=off` to skip Watchman and force the `fs.watch` fallback. */
    watch: (path: PathLike, options?: WatchOptions) => Flow<WatchEvent, never>

    /** Join path segments with the platform separator and normalize the result. */
    join: (...segments: string[]) => Operation<string>
    /** The directory portion of a path. */
    dirname: (path: string) => Operation<string>
    /** The final portion of a path; strips a trailing `suffix` when it matches. */
    basename: (path: string, suffix?: string) => Operation<string>
    /** The extension of the path (including the leading dot), or `''` when there is none. */
    extname: (path: string) => Operation<string>
    /** Whether the path is absolute. */
    isAbsolute: (path: string) => Operation<boolean>

    chmod: (path: PathLike, mode: number) => Operation<void>
    symlink: (
      target: PathLike,
      path: PathLike,
      type?: 'file' | 'dir' | 'junction',
    ) => Operation<void>
    readlink: (path: PathLike) => Operation<string>
    exec: (cmd: string, args?: readonly string[], options?: ExecOptions) => Operation<ExecResult>
    spawn: (
      cmd: string,
      args?: readonly string[],
      options?: SpawnOptions,
    ) => Operation<ProcessHandle>

    tcpListen: (options: TcpListenOptions, onConnection: TcpHandler) => Operation<TcpServer>
    tcpConnect: (options: TcpConnectOptions) => Operation<TcpSocket>
    udpBind: (options?: UdpBindOptions) => Operation<UdpSocket>

    /** List the machine's network interface addresses (via `node:os`). */
    ip: () => Operation<NetworkInterface[]>

    /** The OS temp directory (via `node:os.tmpdir()`). */
    tmpdir: () => Operation<string>

    /** The current working directory: `process.cwd()` on Bun/Node; in a browser the page's
     * directory (`location.pathname` up to its last `/`), `/` when there is no location. */
    cwd: () => Operation<string>

    /** The user's home directory (`node:os.homedir()`); unsupported in the browser. */
    homeDir: () => Operation<string>

    /** Resolve an S3 client bound to `options` (falls back to the S3 env when a field is omitted): on Bun
     * its built-in `S3Client`, elsewhere a dependency-free SigV4-over-`fetch` client (the browser has
     * none — its operations fail `io-unsupported`). The client's own operations are lazy. */
    s3: (options?: S3Options) => Operation<S3Client>
  }
}
