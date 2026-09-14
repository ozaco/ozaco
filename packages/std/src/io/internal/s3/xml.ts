import type { Helpers } from '../../types/helpers'

// The three XML documents the fetch client exchanges with S3: a bucket listing (parsed), the
// multipart-upload initiation reply (parsed for its id), and the multipart completion request
// (rendered). S3's documents are flat and predictable, so a tag scanner is all that is needed.

const text = (xml: string, tag: string): string | undefined =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'u').exec(xml)?.[1]

const decode = (value: string): string =>
  value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')

const encode = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** `ListBucketResult` → the native listing shape `createS3` maps from. */
export const parseListing = (xml: string) => ({
  contents: [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)].map(match => {
    const entry = match[1]!
    const modified = text(entry, 'LastModified')

    return {
      key: decode(text(entry, 'Key') ?? ''),
      size: Number(text(entry, 'Size') ?? 0),
      etag: text(entry, 'ETag'),
      lastModified: modified ? new Date(modified) : undefined,
    }
  }),
  isTruncated: text(xml, 'IsTruncated') === 'true',
  nextContinuationToken: text(xml, 'NextContinuationToken'),
})

/** `InitiateMultipartUploadResult` → its `UploadId`. */
export const parseUploadId = (xml: string): string | undefined => text(xml, 'UploadId')

/** The `CompleteMultipartUpload` request body listing every part with its ETag. */
export const renderCompletion = (parts: readonly Helpers.S3Part[]): string =>
  `<CompleteMultipartUpload>${parts
    .map(
      part =>
        `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${encode(part.etag)}</ETag></Part>`,
    )
    .join('')}</CompleteMultipartUpload>`
