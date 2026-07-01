import type { Future, Operation, Stream } from 'std:effect'

import type {
  ExecOptions,
  ExecResult,
  HashAlgorithm,
  IOStat,
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

  chmod: (path: PathLike, mode: number) => Future<void, unknown>
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
}
