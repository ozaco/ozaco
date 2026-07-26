const isBlob = (value: unknown): value is Blob =>
  typeof Blob !== 'undefined' && value instanceof Blob

const containsBlob = (value: unknown): boolean =>
  isBlob(value) || (Array.isArray(value) && value.some(item => isBlob(item)))

const append = (form: FormData, key: string, value: unknown): void => {
  if (value === undefined) {
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      append(form, key, item)
    }
    return
  }
  if (isBlob(value)) {
    const filename = 'name' in value && typeof value.name === 'string' ? value.name : undefined
    if (filename) {
      form.append(key, value, filename)
    } else {
      form.append(key, value)
    }
    return
  }
  if (value !== null && typeof value === 'object') {
    form.append(key, JSON.stringify(value))
    return
  }
  form.append(key, String(value))
}

/** Build multipart only when the call contains a top-level Blob/File; otherwise preserve JSON. */
export const toFormData = (args: unknown): FormData | undefined => {
  if (typeof FormData !== 'undefined' && args instanceof FormData) {
    return args
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return undefined
  }

  const entries = Object.entries(args)
  if (!entries.some(([, value]) => containsBlob(value))) {
    return undefined
  }

  /**
   * Plain fields FIRST, files after — never the caller's key order.
   *
   * The gateway folds only the fields AHEAD of the first file into the validated body (the same
   * convention S3 form uploads mandate), and an object literal's key order is not something a
   * caller should have to know is load-bearing: `{ file, label }` and `{ label, file }` must be
   * the same call.
   */
  const form = new FormData()
  for (const [key, value] of entries) {
    if (!containsBlob(value)) {
      append(form, key, value)
    }
  }
  for (const [key, value] of entries) {
    if (containsBlob(value)) {
      append(form, key, value)
    }
  }
  return form
}
