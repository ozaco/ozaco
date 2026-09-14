import { attempt, run } from 'std:effect'
import { IO, IOErrors } from 'std:io'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'

import { WebIO } from 'std:io/impl/web'

import { createS3 } from '../../src/io/internal/s3'
import { fetchS3Client } from '../../src/io/internal/s3-fetch'

// The SigV4-over-fetch client used by NodeIO, exercised against a stubbed global `fetch` — no
// network, no credentials. Covers the object ops, list XML parsing, presign URL shape, and a SigV4
// known-answer test against an independent node:crypto derivation.

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

const CONFIG = {
  bucket: 'bucket',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  endpoint: 'http://localhost:9000',
} as const

const originalFetch = globalThis.fetch

/** Replace `fetch` with a recorder that answers each call from `responses` in order (last one repeats). */
const stubFetch = (...responses: Response[]): Captured[] => {
  const calls: Captured[] = []
  let index = 0
  globalThis.fetch = ((input: URL | string, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body,
    })
    const response = responses[Math.min(index, responses.length - 1)]!
    index += 1
    return Promise.resolve(response.clone())
  }) as AnyType
  return calls
}

afterEach(() => {
  globalThis.fetch = originalFetch
  setSystemTime()
})

describe('fetch S3 client — object operations', () => {
  it('write PUTs the body path-style, returns the byte count, and signs every request', async () => {
    const calls = stubFetch(new Response('', { status: 200 }))
    const s3 = createS3(fetchS3Client(CONFIG))

    const outcome = await run(function* () {
      return {
        text: yield* s3.write('dir/héllo world.txt', 'payload'),
        bytes: yield* s3.write('raw.bin', Uint8Array.from([1, 2, 3])),
      }
    })

    expect(unwrap(outcome)).toEqual({ text: 7, bytes: 3 })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.method).toBe('PUT')
    // path-style `<endpoint>/<bucket>/<key>` with each segment RFC 3986-encoded
    expect(calls[0]!.url).toBe('http://localhost:9000/bucket/dir/h%C3%A9llo%20world.txt')
    expect(calls[0]!.body).toBe('payload')
    expect(calls[0]!.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u,
    )
    expect(calls[0]!.headers['x-amz-content-sha256']).toBe(
      createHash('sha256').update('payload').digest('hex'),
    )
    expect(calls[0]!.headers.host).toBe('localhost:9000')
  })

  it('stat HEADs the object and maps the response headers', async () => {
    const calls = stubFetch(
      new Response(null, {
        status: 200,
        headers: {
          'content-length': '42',
          etag: '"abc123"',
          'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
          'content-type': 'text/plain',
        },
      }),
    )
    const s3 = createS3(fetchS3Client(CONFIG))

    const outcome = await run(function* () {
      return yield* s3.stat('some/key')
    })

    expect(unwrap(outcome)).toEqual({
      size: 42,
      etag: '"abc123"',
      lastModified: new Date('Wed, 21 Oct 2015 07:28:00 GMT'),
      type: 'text/plain',
    })
    expect(calls[0]!.method).toBe('HEAD')
    expect(calls[0]!.url).toBe('http://localhost:9000/bucket/some/key')
  })

  it('exists is true on 200 and false on 404 (no failure)', async () => {
    stubFetch(
      new Response(null, { status: 200 }),
      new Response('nope', { status: 404, statusText: 'Not Found' }),
    )
    const s3 = createS3(fetchS3Client(CONFIG))

    const outcome = await run(function* () {
      return { present: yield* s3.exists('a'), absent: yield* s3.exists('b') }
    })

    expect(unwrap(outcome)).toEqual({ present: true, absent: false })
  })

  it('delete sends DELETE to the object URL', async () => {
    const calls = stubFetch(new Response(null, { status: 204 }))
    const s3 = createS3(fetchS3Client(CONFIG))

    const outcome = await run(function* () {
      yield* s3.delete('gone/key')
      return 'done'
    })

    expect(unwrap(outcome)).toBe('done')
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toBe('http://localhost:9000/bucket/gone/key')
  })

  it('a non-2xx stat/read fails std:io.s3-failed with the status in the message', async () => {
    stubFetch(new Response('denied', { status: 403, statusText: 'Forbidden' }))
    const s3 = createS3(fetchS3Client(CONFIG))

    const outcome = await run(function* () {
      const stat = yield* attempt(() => s3.stat('k'))
      const read = yield* attempt(() => s3.read('k'))
      return {
        stat: isFailure(stat) ? [stat.error, stat.message] : 'no-failure',
        read: isFailure(read) ? read.error : 'no-failure',
      }
    })

    expect(unwrap(outcome)).toEqual({
      stat: [IOErrors.S3Failed, 's3 403 Forbidden for "k"'],
      read: IOErrors.S3Failed,
    })
  })
})

describe('fetch S3 client — list', () => {
  const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name>
  <Prefix>photos/</Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>2</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr</NextContinuationToken>
  <Contents>
    <Key>photos/2006/January/sample.jpg</Key>
    <LastModified>2009-10-12T17:50:30.000Z</LastModified>
    <ETag>"fba9dede5f27731c9771645a39863328"</ETag>
    <Size>142863</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>photos/2006/February/sample2.jpg</Key>
    <LastModified>2009-10-12T17:50:30.000Z</LastModified>
    <ETag>"ef7f2a9e0e0e5c3c0e0e0e0e0e0e0e0e"</ETag>
    <Size>3</Size>
  </Contents>
</ListBucketResult>`

  it('sends a list-type=2 GET on the bucket URL and parses the ListBucketResult XML', async () => {
    const calls = stubFetch(new Response(LIST_XML, { status: 200 }))
    const s3 = createS3(fetchS3Client(CONFIG))

    const outcome = await run(function* () {
      return yield* s3.list({
        prefix: 'photos/',
        maxKeys: 2,
        continuationToken: 'tok',
        startAfter: 'p',
      })
    })

    expect(unwrap(outcome)).toEqual({
      contents: [
        {
          key: 'photos/2006/January/sample.jpg',
          size: 142_863,
          etag: '"fba9dede5f27731c9771645a39863328"',
          lastModified: new Date('2009-10-12T17:50:30.000Z'),
        },
        {
          key: 'photos/2006/February/sample2.jpg',
          size: 3,
          etag: '"ef7f2a9e0e0e5c3c0e0e0e0e0e0e0e0e"',
          lastModified: new Date('2009-10-12T17:50:30.000Z'),
        },
      ],
      truncated: true,
      continuationToken: '1ueGcxLPRx1Tr',
    })

    const url = new URL(calls[0]!.url)
    expect(url.origin + url.pathname).toBe('http://localhost:9000/bucket')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'list-type': '2',
      prefix: 'photos/',
      'max-keys': '2',
      'continuation-token': 'tok',
      'start-after': 'p',
    })
    expect(calls[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /u)
  })

  it('an untruncated listing carries no continuation token', async () => {
    stubFetch(
      new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', {
        status: 200,
      }),
    )
    const s3 = createS3(fetchS3Client(CONFIG))

    const outcome = await run(function* () {
      return yield* s3.list()
    })

    expect(unwrap(outcome)).toEqual({
      contents: [],
      truncated: false,
      continuationToken: undefined,
    })
  })
})

describe('fetch S3 client — presign', () => {
  it('signs into the query string with host as the only signed header and UNSIGNED-PAYLOAD', async () => {
    setSystemTime(new Date('2013-05-24T00:00:00Z'))
    const s3 = createS3(fetchS3Client(CONFIG))

    const outcome = await run(function* () {
      return {
        get: yield* s3.presign('photos/a b.jpg'),
        put: yield* s3.file('up.bin').presign({ method: 'PUT', expiresIn: 600 }),
      }
    })

    const { get, put } = unwrap(outcome)
    const url = new URL(get)
    expect(url.origin + url.pathname).toBe('http://localhost:9000/bucket/photos/a%20b.jpg')
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    )
    expect(url.searchParams.get('X-Amz-Date')).toBe('20130524T000000Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('86400')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/u)
    expect(url.searchParams.has('X-Amz-Security-Token')).toBe(false)
    // no Authorization header form anywhere in a presigned URL
    expect(get).not.toContain('Authorization')

    expect(new URL(put).searchParams.get('X-Amz-Expires')).toBe('600')

    // independent reference for the GET signature — signs UNSIGNED-PAYLOAD over the query
    const query = [...url.searchParams.entries()]
      .filter(([key]) => key !== 'X-Amz-Signature')
      .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => `${key}=${value}`)
      .join('&')
    const canonical = [
      'GET',
      '/bucket/photos/a%20b.jpg',
      query,
      'host:localhost:9000\n',
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n')
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      '20130524T000000Z',
      '20130524/us-east-1/s3/aws4_request',
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n')
    const expected = createHmac('sha256', signingKey('20130524')).update(stringToSign).digest('hex')
    expect(url.searchParams.get('X-Amz-Signature')).toBe(expected)
  })

  it('includes X-Amz-Security-Token when a session token is configured', async () => {
    const s3 = createS3(fetchS3Client({ ...CONFIG, sessionToken: 'sess/tok' }))

    const outcome = await run(function* () {
      return yield* s3.presign('k')
    })

    expect(new URL(unwrap(outcome)).searchParams.get('X-Amz-Security-Token')).toBe('sess/tok')
  })
})

// AWS SigV4 key chain: kSecret → kDate → kRegion → kService → kSigning
const signingKey = (dateStamp: string): Buffer => {
  const kDate = createHmac('sha256', `AWS4${CONFIG.secretAccessKey}`).update(dateStamp).digest()
  const kRegion = createHmac('sha256', kDate).update(CONFIG.region).digest()
  const kService = createHmac('sha256', kRegion).update('s3').digest()
  return createHmac('sha256', kService).update('aws4_request').digest()
}

describe('fetch S3 client — SigV4 known answer', () => {
  it('the Authorization header for a fixed GET matches an independent node:crypto derivation', async () => {
    setSystemTime(new Date('2013-05-24T00:00:00Z'))
    const calls = stubFetch(new Response('body', { status: 200 }))
    // no endpoint → regional AWS host, path-style
    const s3 = createS3(
      fetchS3Client({
        bucket: 'examplebucket',
        accessKeyId: CONFIG.accessKeyId,
        secretAccessKey: CONFIG.secretAccessKey,
        region: CONFIG.region,
      }),
    )

    const outcome = await run(function* () {
      return yield* s3.file('test.txt').text()
    })

    expect(unwrap(outcome)).toBe('body')
    expect(calls[0]!.url).toBe('https://s3.us-east-1.amazonaws.com/examplebucket/test.txt')

    const emptyHash = createHash('sha256').update('').digest('hex')
    expect(emptyHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(calls[0]!.headers['x-amz-date']).toBe('20130524T000000Z')
    expect(calls[0]!.headers['x-amz-content-sha256']).toBe(emptyHash)

    const canonicalRequest = [
      'GET',
      '/examplebucket/test.txt',
      '',
      'host:s3.us-east-1.amazonaws.com\n' +
        `x-amz-content-sha256:${emptyHash}\n` +
        'x-amz-date:20130524T000000Z\n',
      'host;x-amz-content-sha256;x-amz-date',
      emptyHash,
    ].join('\n')
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      '20130524T000000Z',
      '20130524/us-east-1/s3/aws4_request',
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n')
    const signature = createHmac('sha256', signingKey('20130524'))
      .update(stringToSign)
      .digest('hex')

    expect(calls[0]!.headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    )
  })

  it('a session token joins the signed headers as x-amz-security-token', async () => {
    const calls = stubFetch(new Response('', { status: 200 }))
    const s3 = createS3(fetchS3Client({ ...CONFIG, sessionToken: 'tok' }))

    await run(function* () {
      return yield* s3.exists('k')
    })

    expect(calls[0]!.headers['x-amz-security-token']).toBe('tok')
    expect(calls[0]!.headers.authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,',
    )
  })
})

describe('IO.actions.s3 on WebIO', () => {
  it('is constructible but every operation fails std:io.unsupported', async () => {
    const outcome = await run(function* () {
      yield* WebIO.use()

      const s3 = yield* IO.actions.s3({ bucket: 'b' })
      const read = yield* attempt(() => s3.read('k'))
      const list = yield* attempt(() => s3.list())
      const presign = yield* attempt(() => s3.file('k').presign())

      return {
        read: isFailure(read) ? read.error : 'no-failure',
        list: isFailure(list) ? list.error : 'no-failure',
        presign: isFailure(presign) ? presign.error : 'no-failure',
      }
    })

    expect(unwrap(outcome)).toEqual({
      read: IOErrors.Unsupported,
      list: IOErrors.Unsupported,
      presign: IOErrors.Unsupported,
    })
  })
})
