/** A `file:///…` URL's path: strips the literal `file:///` only, then percent-decodes — see
 * `toPath` for what that leaves out. */
export const fileUrlToPath = (url: string): string => {
  const stripped = url.replace(/^file:\/\/\//u, '/')
  return decodeURIComponent(stripped)
}
