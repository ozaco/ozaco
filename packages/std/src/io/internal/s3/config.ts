import type { AnyType } from 'std:shared'

import type { S3Options } from '../../types/common'
import type { Helpers } from '../../types/helpers'

const env = (key: string): string | undefined => (globalThis as AnyType).process?.env?.[key]

/** AWS's default region when nothing names one. */
export const DEFAULT_REGION = 'us-east-1'

/** S3's multipart minimum: parts below 5 MiB are rejected by AWS (the last part excepted). */
export const DEFAULT_PART_SIZE = 5 * 1024 * 1024

/**
 * Merge explicit options over the environment: Bun's `S3_*` names first, then the AWS SDK names,
 * so one process configuration serves both platforms.
 */
export const resolveConfig = (options: S3Options): Helpers.S3Config => ({
  accessKeyId: options.accessKeyId ?? env('S3_ACCESS_KEY_ID') ?? env('AWS_ACCESS_KEY_ID') ?? '',
  secretAccessKey:
    options.secretAccessKey ?? env('S3_SECRET_ACCESS_KEY') ?? env('AWS_SECRET_ACCESS_KEY') ?? '',
  sessionToken: options.sessionToken ?? env('S3_SESSION_TOKEN') ?? env('AWS_SESSION_TOKEN'),
  region: options.region ?? env('S3_REGION') ?? env('AWS_REGION') ?? DEFAULT_REGION,
  bucket: options.bucket ?? env('S3_BUCKET') ?? '',
  endpoint: options.endpoint ?? env('S3_ENDPOINT') ?? env('AWS_ENDPOINT_URL_S3'),
  partSize: options.partSize ?? DEFAULT_PART_SIZE,
})

/** The base every URL is built on: the configured endpoint, else the regional AWS host. Always
 * path-style (`<base>/<bucket>/<key>`), never virtual-hosted — works with MinIO and friends. */
export const baseUrl = (config: Helpers.S3Config): string =>
  (config.endpoint ?? `https://s3.${config.region}.amazonaws.com`).replace(/\/$/u, '')
