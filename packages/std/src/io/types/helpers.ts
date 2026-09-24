import type { AnyType } from 'std:shared'

import type { IODef } from './io'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  /** Per-origin HLC send state (last minted time + same-ms counter) — nothing to do with wall
   * clocks or timers. */
  export interface Clock {
    ts: number
    counter: number
  }

  export interface SpawnConfig {
    cwd?: string
    env?: Record<string, string>
    timeout?: number
  }

  /** `SpawnOptions.stdio` resolved per stream. */
  export interface StdioConfig {
    stdin: IODef.StdioMode
    stdout: IODef.StdioMode
    stderr: IODef.StdioMode
  }

  /** Fully-resolved S3 settings (options merged over the env fallbacks). */
  export interface S3Config {
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly sessionToken: string | undefined
    readonly region: string
    readonly bucket: string
    readonly endpoint: string | undefined
    readonly partSize: number
  }

  /** One signed HTTP exchange against the bucket, before `fetch` sees it. */
  export interface S3Request {
    readonly method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD'
    readonly url: URL
    /** Whole body to send; omitted for bodiless methods. */
    readonly body?: Uint8Array | string | undefined
    /** Extra headers (content-type…); `host`, `x-amz-*` and `authorization` are added by signing. */
    readonly headers?: Record<string, string> | undefined
  }

  /** The signed-and-sent side of the fetch client: URL building plus one `send`. */
  export interface S3Transport {
    readonly config: S3Config
    objectUrl(key: string): URL
    bucketUrl(): URL
    send(request: S3Request): Promise<Response>
  }

  /** One completed multipart part. */
  export interface S3Part {
    readonly partNumber: number
    readonly etag: string
  }

  /**
   * The native client surface `createS3` drives — the slice of Bun's `S3Client` that the effect
   * wrapper needs, also produced by the fetch client so one wrapper serves both. `stream()` is
   * sync on Bun and async on fetch; `writer()` (streaming multipart sink) exists on Bun only.
   */
  export interface S3Native {
    file(key: string): S3NativeFile
    write(key: string, data: AnyType): Promise<number>
    exists(key: string): Promise<boolean>
    delete(key: string): Promise<void>
    stat(key: string): Promise<AnyType>
    list(options?: AnyType): Promise<AnyType>
    presign(key: string, options?: AnyType): string
  }

  export interface S3NativeFile {
    text(): Promise<string>
    json(): Promise<AnyType>
    bytes(): Promise<Uint8Array>
    arrayBuffer(): Promise<ArrayBuffer>
    stream(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
    write(data: AnyType): Promise<number>
    writer?(options?: AnyType): S3NativeSink
    exists(): Promise<boolean>
    delete(): Promise<void>
    stat(): Promise<AnyType>
    presign(options?: AnyType): string
  }

  /** Bun's `NetworkSink` subset: buffered multipart writes with a promise-returning `end`. */
  export interface S3NativeSink {
    write(chunk: Uint8Array): number | Promise<number>
    end(): number | Promise<number>
  }
}
