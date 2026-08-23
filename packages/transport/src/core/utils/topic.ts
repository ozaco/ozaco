/**
 * Subject matching shared by the in-process driver and by backends without native wildcards:
 * dot-separated segments, `*` matches exactly one segment, `>` matches one or more trailing
 * segments. Literal topics match only themselves.
 */
export const matchTopic = (pattern: string, topic: string): boolean => {
  if (pattern === topic) {
    return true
  }
  const want = pattern.split('.')
  const have = topic.split('.')

  for (const [index, segment] of want.entries()) {
    if (segment === '>') {
      return have.length > index
    }
    if (index >= have.length || (segment !== '*' && segment !== have[index])) {
      return false
    }
  }

  return want.length === have.length
}

/** Whether a topic is a subscription pattern (carries wildcards). */
export const isPattern = (topic: string): boolean => topic.includes('*') || topic.includes('>')

/** A publishable topic must be non-empty, wildcard-free and have no empty segments. */
export const isValidTopic = (topic: string): boolean =>
  topic.length > 0 && !isPattern(topic) && !topic.split('.').some(segment => segment === '')

/** A topic under an application prefix — what the backend sees. */
export const prefixed = (prefix: string, topic: string): string => `${prefix}.${topic}`

/** The application-relative topic of a backend subject (`null` when it is not under the
 * prefix — traffic of another application sharing the broker). */
export const unprefixed = (prefix: string, subject: string): string | null =>
  subject.startsWith(`${prefix}.`) ? subject.slice(prefix.length + 1) : null

/** A consumer name under a subscription prefix (`group` / `durable` names). */
export const namespaced = (prefix: string | undefined, name: string): string =>
  prefix === undefined ? name : `${prefix}.${name}`

/** An application prefix follows the publishable-topic rules (`transport.configuration`
 * otherwise). */
export const isValidPrefix = (prefix: string): boolean => isValidTopic(prefix)
