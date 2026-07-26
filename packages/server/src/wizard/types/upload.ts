/** One multipart file field in the generated OpenAPI/client contract. */
export interface UploadFieldOptions {
  /** Whether Docs and the generated client mark this field as required. Defaults to `true`. */
  readonly required?: boolean | undefined
  /** Accept repeated files under the same multipart field name. Defaults to `false`. */
  readonly multiple?: boolean | undefined
}

/** A short list means required, single-file fields; the object form controls cardinality. */
export type UploadFields = readonly string[] | Readonly<Record<string, true | UploadFieldOptions>>

/**
 * Uploads are streamed, always: the handler pulls the parts itself (`useSource(multistream)`) and
 * pipes each file straight to its destination. `files` describes the CONTRACT — which multipart
 * fields exist — for Docs and the generated client, not a delivery mode.
 */
export interface UploadOptions {
  readonly files: UploadFields
}

/** Normalized upload metadata shared by the Wizard builder and the existing Docs plugin. */
export interface UploadMetadata {
  readonly fields: readonly (Required<UploadFieldOptions> & { readonly name: string })[]
}
