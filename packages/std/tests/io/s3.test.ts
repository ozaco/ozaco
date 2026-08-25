import { attempt, run } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { createS3 } from '../../src/io/internal/s3'
import { fetchS3Client } from '../../src/io/internal/s3-fetch'

describe('s3 fetch client', () => {
  it('surfaces non-ok responses as s3-failed failures, not native errors', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (() =>
      Promise.resolve(new Response('denied', { status: 403, statusText: 'Forbidden' }))) as AnyType

    try {
      const s3 = createS3(
        fetchS3Client({
          bucket: 'bucket',
          accessKeyId: 'key',
          secretAccessKey: 'secret',
          region: 'us-east-1',
          endpoint: 'http://localhost:1',
        }),
      )

      const outcome = await run(function* () {
        return yield* attempt(() => s3.file('some/key').text())
      })

      expect(isFailure(outcome)).toBe(true)
      if (isFailure(outcome)) {
        expect(outcome.error).toBe('s3-failed')
        expect(outcome.message).toBe('s3 403 Forbidden for "some/key"')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
