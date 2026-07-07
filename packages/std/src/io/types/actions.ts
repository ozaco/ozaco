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
  WalkEntry,
  WalkOptions,
} from './common'

export type IOActions = {
  env: <R extends Record<string, unknown>, K extends keyof R = never>(
    mapper: (data: Record<string, string | undefined>) => R,
    optional?: readonly K[],
  ) => Future<{ [P in keyof R]: P extends K ? R[P] : NonNullable<R[P]> }, unknown>

  randomBytes: (length: number) => Future<Uint8Array, unknown>
  hmac: (algorithm: HashAlgorithm, key: Uint8Array, data: Uint8Array) => Future<Uint8Array, unknown>
  hash: (algorithm: HashAlgorithm, data: Uint8Array) => Future<Uint8Array, unknown>

  /** Encrypt with a secret (AES-256-GCM, key derived from the secret via scrypt). Reversible via {@link decrypt}. */
  encrypt: (data: Uint8Array | string, secret: string) => Future<Uint8Array, unknown>
  /** Decrypt what {@link encrypt} produced; fails on a wrong secret or tampered data. */
  decrypt: (data: Uint8Array, secret: string) => Future<Uint8Array, unknown>

  /** Generate an Ed25519 key pair for {@link sign} / {@link verify}. */
  generateKeyPair: () => Future<KeyPair, unknown>
  /** Sign data with an Ed25519 private key (from {@link generateKeyPair}); returns a 64-byte signature. */
  sign: (data: Uint8Array | string, privateKey: Uint8Array) => Future<Uint8Array, unknown>
  /** Verify an Ed25519 signature against the public key; `true` if valid, `false` if not. */
  verify: (
    data: Uint8Array | string,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ) => Future<boolean, unknown>

  fromReadable: (
    target: ReadableLike,
    options?: { destroy?: boolean },
  ) => Stream<Uint8Array, StreamClose>
  toReadable: (
    source: Stream<Uint8Array, unknown>,
  ) => Future<{ readable: ReadableStream<Uint8Array>; pump: Operation<void, unknown> }>
  readStream: (path: PathLike) => Stream<Uint8Array, StreamClose>
  writeStream: (
    path: PathLike,
    source: Stream<Uint8Array, unknown>,
    options?: {
      flags?: number
    },
  ) => Future<void, unknown>
  read: (path: PathLike) => Future<Uint8Array, unknown>
  readText: (path: PathLike, encoding?: string) => Future<string, unknown>
  write: (
    path: PathLike,
    data: Uint8Array | string,
    options?: {
      flags?: number
    },
  ) => Future<void, unknown>
  append: (path: PathLike, data: Uint8Array) => Future<void, unknown>
  copy: (
    src: PathLike,
    dest: PathLike,
    options?: {
      flags?: number
    },
  ) => Future<void, unknown>
  rename: (
    src: PathLike,
    dest: PathLike,
    options?: {
      flags?: number
    },
  ) => Future<void, unknown>
  rm: (
    path: PathLike,
    options?: {
      recursive?: boolean
      force?: boolean
    },
  ) => Future<void, unknown>
  exists: (path: PathLike) => Future<boolean, unknown>
  stat: (path: PathLike) => Future<IOStat, unknown>
  lstat: (path: PathLike) => Future<IOStat, unknown>
  readdir: (
    path: PathLike,
    options?: {
      recursive?: boolean
    },
  ) => Future<string[], unknown>
  ensureDir: (path: PathLike) => Future<void, unknown>
  ensureFile: (path: PathLike) => Future<void, unknown>
  emptyDir: (path: PathLike) => Future<void, unknown>
  walk: (root: PathLike, options?: WalkOptions) => Future<WalkEntry[], unknown>

  /** Join path segments with the platform separator and normalize the result. */
  join: (...segments: string[]) => Future<string, unknown>
  /** The directory portion of a path. */
  dirname: (path: string) => Future<string, unknown>
  /** The final portion of a path; strips a trailing `suffix` when it matches. */
  basename: (path: string, suffix?: string) => Future<string, unknown>
  /** The extension of the path (including the leading dot), or `''` when there is none. */
  extname: (path: string) => Future<string, unknown>
  /** Whether the path is absolute. */
  isAbsolute: (path: string) => Future<boolean, unknown>

  chmod: (path: PathLike, mode: number) => Future<void, unknown>
  symlink: (
    target: PathLike,
    path: PathLike,
    type?: 'file' | 'dir' | 'junction',
  ) => Future<void, unknown>
  readlink: (path: PathLike) => Future<string, unknown>
  exec: (
    cmd: string,
    args?: readonly string[],
    options?: ExecOptions,
  ) => Future<ExecResult, unknown>
  spawn: (
    cmd: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ) => Future<ProcessHandle, unknown>

  tcpListen: (options: TcpListenOptions, onConnection: TcpHandler) => Future<TcpServer, unknown>
  tcpConnect: (options: TcpConnectOptions) => Future<TcpSocket, unknown>
  udpBind: (options?: UdpBindOptions) => Future<UdpSocket, unknown>

  /** List the machine's network interface addresses (via `node:os`). */
  ip: () => Future<NetworkInterface[], unknown>
}
