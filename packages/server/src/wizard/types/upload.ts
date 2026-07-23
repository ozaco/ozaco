/** How Gateway should expose uploaded files to a Wizard handler. */
export type UploadMode = 'buffer' | 'stream'

/** One multipart file field in the generated OpenAPI/client contract. */
export interface UploadFieldOptions {
  /** Whether Docs and the generated client mark this field as required. Defaults to `true`. */
  readonly required?: boolean | undefined
  /** Accept repeated files under the same multipart field name. Defaults to `false`. */
  readonly multiple?: boolean | undefined
}

/** A short list means required, single-file fields; the object form controls cardinality. */
export type UploadFields = readonly string[] | Readonly<Record<string, true | UploadFieldOptions>>

export interface UploadOptions {
  /** `buffer` spills to request-scoped temp files; `stream` exposes backpressured parts. */
  readonly mode?: UploadMode | undefined
  readonly files: UploadFields
}

/** Normalized upload metadata shared by the Wizard builder and the existing Docs plugin. */
export interface UploadMetadata {
  readonly mode: UploadMode
  readonly fields: readonly (Required<UploadFieldOptions> & { readonly name: string })[]
}
