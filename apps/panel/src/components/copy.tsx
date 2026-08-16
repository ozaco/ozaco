import { useRef, useState } from 'react'
import { Button } from 'react-aria-components'

import { CheckIcon, CopyIcon } from './icons'
import { useToasts } from './toasts'

/** Copy-to-clipboard affordance with a transient check state. */
export const CopyButton = ({
  text,
  label = 'Copy to clipboard',
}: {
  readonly text: string | (() => string)
  readonly label?: string
}) => {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toasts = useToasts()

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(typeof text === 'string' ? text : text())
      setCopied(true)

      if (timer.current !== null) {
        clearTimeout(timer.current)
      }

      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      toasts.error('Clipboard unavailable — copy blocked by the browser')
    }
  }

  return (
    <Button
      aria-label={copied ? 'Copied' : label}
      className='text-muted data-hovered:text-ink data-pressed:text-accent rounded p-1'
      onPress={() => {
        void copy()
      }}>
      {copied ? <CheckIcon className='text-ok' /> : <CopyIcon />}
    </Button>
  )
}
