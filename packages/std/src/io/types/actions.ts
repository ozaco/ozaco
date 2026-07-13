import type { Future, Operation, Stream } from 'std:effect'

import type {
  ExecOptions,
  ExecResult,
  HashAlgorithm,
  IOStat,
  KeyPair,
  NetworkInterface,
  PathLike,
  ProcessHandle,
  ReadableLike,
  SpawnOptions,
  StreamClose,
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
  ) => Future<{ [P in keyof R]: P extends K ? R[P] : NonNullable<R[P]> }>

  randomBytes: (length: number) => Future<Uint8Array>
  /** Generate a ULID — lexicographically sortable, monotonic within a `window`. See {@link UlidOptions}. */
  ulid: (options?: UlidOptions) => Future<string>
  /** Generate an RFC 4122 version-4 (random) UUID string. */
  uuid: () => Future<string>
  hmac: (algorithm: HashAlgorithm, key: Uint8Array, data: Uint8Array) => Future<Uint8Array>
  hash: (algorithm: HashAlgorithm, data: Uint8Array) => Future<Uint8Array>

  /** Encrypt with a secret (AES-256-GCM, key derived from the secret via scrypt). Reversible via {@link decrypt}. */
  encrypt: (data: Uint8Array | string, secret: string) => Future<Uint8Array>
  /** Decrypt what {@link encrypt} produced; fails on a wrong secret or tampered data. */
  decrypt: (data: Uint8Array, secret: string) => Future<Uint8Array>

  /** Generate an Ed25519 key pair for {@link sign} / {@link verify}. */
  generateKeyPair: () => Future<KeyPair>
  /** Sign data with an Ed25519 private key (from {@link generateKeyPair}); returns a 64-byte signature. */
  sign: (data: Uint8Array | string, privateKey: Uint8Array) => Future<Uint8Array>
  /** Verify an Ed25519 signature against the public key; `true` if valid, `false` if not. */
  verify: (
    data: Uint8Array | string,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ) => Future<boolean>

  fromReadable: (
    target: ReadableLike,
    options?: { destroy?: boolean },
  ) => Stream<Uint8Array, StreamClose>
  toReadable: (
    source: Stream<Uint8Array, unknown>,
  ) => Future<{ readable: ReadableStream<Uint8Array>; pump: Operation<void> }>
  readStream: (path: PathLike) => Stream<Uint8Array, StreamClose>
  writeStream: (
    path: PathLike,
    source: Stream<Uint8Array, unknown>,
    options?: {
      flags?: number
    },
  ) => Future<void>
  read: (path: PathLike) => Future<Uint8Array>
  readText: (path: PathLike, encoding?: string) => Future<string>
  write: (
    path: PathLike,
    data: Uint8Array | string,
    options?: {
      flags?: number
    },
  ) => Future<void>
  append: (path: PathLike, data: Uint8Array) => Future<void>
  copy: (
    src: PathLike,
    dest: PathLike,
    options?: {
      flags?: number
    },
  ) => Future<void>
  rename: (
    src: PathLike,
    dest: PathLike,
    options?: {
      flags?: number
    },
  ) => Future<void>
  rm: (
    path: PathLike,
    options?: {
      recursive?: boolean
      force?: boolean
    },
  ) => Future<void>
  exists: (path: PathLike) => Future<boolean>
  stat: (path: PathLike) => Future<IOStat>
  lstat: (path: PathLike) => Future<IOStat>
  readdir: (
    path: PathLike,
    options?: {
      recursive?: boolean
    },
  ) => Future<string[]>
  ensureDir: (path: PathLike) => Future<void>
  ensureFile: (path: PathLike) => Future<void>
  emptyDir: (path: PathLike) => Future<void>
  walk: (root: PathLike, options?: WalkOptions) => Future<WalkEntry[]>
  /** Watch a file or directory via `fsPromises.watch` (event-based, recursive-capable), streaming
   * {@link WatchEvent}s until the stream is torn down. */
  watch: (path: PathLike, options?: WatchOptions) => Stream<WatchEvent, never>

  /** Join path segments with the platform separator and normalize the result. */
  join: (...segments: string[]) => Future<string>
  /** The directory portion of a path. */
  dirname: (path: string) => Future<string>
  /** The final portion of a path; strips a trailing `suffix` when it matches. */
  basename: (path: string, suffix?: string) => Future<string>
  /** The extension of the path (including the leading dot), or `''` when there is none. */
  extname: (path: string) => Future<string>
  /** Whether the path is absolute. */
  isAbsolute: (path: string) => Future<boolean>

  chmod: (path: PathLike, mode: number) => Future<void>
  symlink: (target: PathLike, path: PathLike, type?: 'file' | 'dir' | 'junction') => Future<void>
  readlink: (path: PathLike) => Future<string>
  exec: (cmd: string, args?: readonly string[], options?: ExecOptions) => Future<ExecResult>
  spawn: (cmd: string, args?: readonly string[], options?: SpawnOptions) => Future<ProcessHandle>

  tcpListen: (options: TcpListenOptions, onConnection: TcpHandler) => Future<TcpServer>
  tcpConnect: (options: TcpConnectOptions) => Future<TcpSocket>
  udpBind: (options?: UdpBindOptions) => Future<UdpSocket>

  /** List the machine's network interface addresses (via `node:os`). */
  ip: () => Future<NetworkInterface[]>
}
