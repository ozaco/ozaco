import type { Operation, Flow } from 'std:effect'

import type {
  ExecOptions,
  ExecResult,
  FlowClose,
  HashAlgorithm,
  Hlc,
  HlcOptions,
  IOStat,
  KeyPair,
  NetworkInterface,
  ObserveHlcOptions,
  PathLike,
  ProcessHandle,
  ReadableLike,
  S3Client,
  S3Options,
  SpawnOptions,
  TcpConnectOptions,
  TcpHandler,
  TcpListenOptions,
  TcpServer,
  TcpSocket,
  UdpBindOptions,
  UdpSocket,
  UlidOptions,
  WalkEntry,
  WalkOptions,
  WatchEvent,
  WatchOptions,
} from './common'

export type IOActions = {
  env: <R extends Record<string, unknown>, K extends keyof R = never>(
    mapper: (data: Record<string, string | undefined>) => R,
    optional?: readonly K[],
  ) => Operation<{ [P in keyof R]: P extends K ? R[P] : NonNullable<R[P]> }>

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
  /** Watch a file or directory via `fsPromises.watch` (event-based, recursive-capable), streaming
   * {@link WatchEvent}s until the stream is torn down. */
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
  symlink: (target: PathLike, path: PathLike, type?: 'file' | 'dir' | 'junction') => Operation<void>
  readlink: (path: PathLike) => Operation<string>
  exec: (cmd: string, args?: readonly string[], options?: ExecOptions) => Operation<ExecResult>
  spawn: (cmd: string, args?: readonly string[], options?: SpawnOptions) => Operation<ProcessHandle>

  tcpListen: (options: TcpListenOptions, onConnection: TcpHandler) => Operation<TcpServer>
  tcpConnect: (options: TcpConnectOptions) => Operation<TcpSocket>
  udpBind: (options?: UdpBindOptions) => Operation<UdpSocket>

  /** List the machine's network interface addresses (via `node:os`). */
  ip: () => Operation<NetworkInterface[]>

  /** The OS temp directory (via `node:os.tmpdir()`). */
  tmpdir: () => Operation<string>

  /** Resolve an S3 client bound to `options` (falls back to the S3 env when a field is omitted): on Bun
   * its built-in `S3Client`, elsewhere a dependency-free SigV4-over-`fetch` client (the browser has
   * none — its operations fail `io-unsupported`). The client's own operations are lazy. */
  s3: (options?: S3Options) => Operation<S3Client>
}
