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

  const form = new FormData()
  for (const [key, value] of entries) {
    append(form, key, value)
  }
  return form
}
