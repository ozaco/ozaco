import type { UploadMetadata, UploadOptions } from '../types'

/** Normalize Wizard's shorthand into stable metadata consumed by Gateway and Docs. */
export const normalizeUpload = (upload: UploadOptions): UploadMetadata => {
  const entries: [string, true | { readonly required?: boolean; readonly multiple?: boolean }][] =
    Array.isArray(upload.files)
      ? upload.files.map(name => [name, true])
      : Object.entries(upload.files)

  const fields = [...new Map(entries).entries()].map(([name, options]) => ({
    name,
    required: options === true ? true : (options.required ?? true),
    multiple: options === true ? false : (options.multiple ?? false),
  }))

  return { fields }
}
