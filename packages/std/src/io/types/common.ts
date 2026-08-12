import type { Operation, Stream } from 'std:effect'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

export type PathLike = string | URL

/** The close value an IO byte stream settles with: `true` on a clean end, or the failure that interrupted it. */
export type StreamClose = true | Result.Failure<unknown>

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

export interface WalkOptions {
  flags?: number | undefined
  maxDepth?: number | undefined
  match?: RegExp[] | undefined
  skip?: RegExp[] | undefined
}

/** A filesystem change reported by {@link IOActions.watch}. */
export interface WatchEvent {
  /** `'rename'` for create/delete/move, `'change'` for content edits (as `fs.watch` reports). */
  type: 'rename' | 'change'
  /** The affected entry name relative to the watched path, or `null` when the platform omits it. */
  path: string | null
}

/** Options for {@link IOActions.watch}. */
export interface WatchOptions {
  /** Watch nested directories too (platform support varies). Defaults to `false`. */
  recursive?: boolean | undefined
}

/** Options for {@link IOActions.ulid}. */
export interface UlidOptions {
  /** Quantize the timestamp to this many ms (`floor(now/window)*window`); default `1` (per-ms). */
  window?: number | undefined
  /** Total id length EXCLUDING `bucket` (10 timestamp chars + `length - 10` random); default `26`. */
  length?: number | undefined
  /** Fixed prefix segment (namespace/shard tag); ids from different buckets never collide. */
  bucket?: string | undefined
}

/** Options shared by {@link IOActions.exec} and {@link IOActions.spawn}. */
export interface ProcessOptions {
  /** Working directory for the child. Defaults to the parent's cwd. */
  cwd?: PathLike
  /** Environment overrides, layered over the parent's `process.env` (set a key to `undefined` to drop it). */
  env?: Record<string, string | undefined>
}

/** Options for {@link IOActions.exec}. */
export interface ExecOptions extends ProcessOptions {
  /** Bytes (or text) written to the child's stdin, which is then closed. */
  stdin?: Uint8Array | string
  /** Kill the child after this many milliseconds. */
  timeout?: number
}

/** Options for {@link IOActions.spawn}. */
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

/** The buffered result of running a command to completion via {@link IOActions.exec}. */
export interface ExecResult extends ProcessStatus {
  stdout: Uint8Array
  stderr: Uint8Array
}

/** A handle to a child process spawned via {@link IOActions.spawn}. */
export interface ProcessHandle {
  /** OS process id (`-1` if the process never started). */
  readonly pid: number
  /** The child's stdout as a byte stream. */
  readonly stdout: Stream<Uint8Array, StreamClose>
  /** The child's stderr as a byte stream. */
  readonly stderr: Stream<Uint8Array, StreamClose>
  /** Resolve with the exit status once the process ends. */
  exited: () => Operation<ProcessStatus>
  /** Write a chunk to the child's stdin. */
  write: (chunk: Uint8Array | string) => Operation<void>
  /** Close the child's stdin. */
  closeStdin: () => Operation<void>
  /** Send a termination signal (default `SIGTERM`). */
  kill: (signal?: number | string) => Operation<void>
}

/** An Ed25519 key pair (DER bytes: public = SPKI, private = PKCS8), from {@link IOActions.generateKeyPair}. */
export interface KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

/** A single network interface address, as reported by {@link IOActions.ip}. */
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

/** Options for {@link IOActions.tcpListen}. */
export interface TcpListenOptions {
  port: number
  /** Interface to bind. Defaults to `0.0.0.0`. */
  hostname?: string
  /** Enable kernel-level `SO_REUSEPORT` load balancing across processes. */
  reusePort?: boolean
}

/** Options for {@link IOActions.tcpConnect}. */
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
  data: Stream<Uint8Array, StreamClose>
  /** Write a chunk, resolving once it has been flushed (honors backpressure). */
  write: (chunk: Uint8Array | string) => Operation<void>
  /** Half-close the socket's write side and tear it down. */
  close: () => Operation<void>
}

/** A per-connection handler; runs as a child of the scope that called {@link IOActions.tcpListen}. */
export type TcpHandler = (socket: TcpSocket) => Operation<void>

/** A handle to a listening TCP server (see {@link IOActions.tcpListen}). */
export interface TcpServer {
  readonly port: number
  readonly hostname: string
  /** Stop accepting connections and shut the server down. */
  close: () => Operation<void>
}

/** Options for {@link IOActions.udpBind}. */
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

/** A handle to a bound UDP socket (see {@link IOActions.udpBind}). */
export interface UdpSocket {
  readonly port: number
  /** Inbound datagrams, buffered from bind time. */
  messages: Stream<UdpDatagram, StreamClose>
  /** Send a datagram to an explicit destination. */
  send: (data: Uint8Array | string, port: number, address: string) => Operation<void>
  /** Close the socket. */
  close: () => Operation<void>
}

// --- S3 (object storage) — Bun's built-in S3Client (BunIO only) ------------------------------------

/** Connection + credentials for an S3 client. Any field may be omitted to fall back to Bun's env
 * (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_REGION` / `S3_BUCKET` / `S3_ENDPOINT`, …). */
export interface S3Options {
  readonly accessKeyId?: string
  readonly secretAccessKey?: string
  readonly sessionToken?: string
  readonly region?: string
  readonly bucket?: string
  readonly endpoint?: string
  /** Canned ACL applied to writes (e.g. `'public-read'`). */
  readonly acl?: string
}

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
  /** The object's byte stream (a platform `ReadableStream`; adapt it with `IO.actions.fromReadable`). */
  stream: () => Operation<ReadableStream<Uint8Array>>
  /** Upload/overwrite the object; resolves to the number of bytes written. */
  write: (data: Uint8Array | string | Blob) => Operation<number>
  exists: () => Operation<boolean>
  delete: () => Operation<void>
  stat: () => Operation<S3Stat>
  /** A presigned URL for this object (default `GET`). */
  presign: (options?: S3PresignOptions) => Operation<string>
}

/** An S3 client bound to a bucket/credentials — `IO.actions.s3(options)`. Uses Bun's built-in
 * `S3Client`; on non-Bun runtimes every operation fails `io-unsupported`. */
export interface S3Client {
  /** A handle to one object. */
  file: (key: string) => S3File
  read: (key: string) => Operation<Uint8Array>
  write: (key: string, data: Uint8Array | string | Blob) => Operation<number>
  exists: (key: string) => Operation<boolean>
  delete: (key: string) => Operation<void>
  stat: (key: string) => Operation<S3Stat>
  list: (options?: S3ListOptions) => Operation<S3ListResult>
  presign: (key: string, options?: S3PresignOptions) => Operation<string>
}
