/** Shared workspace chrome class recipes: underline sub-tabs, selects, inputs, section titles. */

import type { ReactNode } from 'react'

export const SUB_TAB_LIST =
  'border-line flex shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b px-2'

export const SUB_TAB =
  '-mb-px cursor-default border-b-2 border-transparent px-2 py-1.5 text-[12px] whitespace-nowrap text-muted outline-none data-hovered:text-ink data-focus-visible:text-ink data-selected:border-accent data-selected:text-ink'

export const SUB_PANEL = 'min-h-0 flex-1 overflow-y-auto outline-none'

export const FIELD_INPUT =
  'border-line bg-surface text-ink data-focused:border-accent w-full rounded border px-2 py-1 font-mono text-[12.5px]'

export const SELECT_BUTTON =
  'border-line bg-surface text-ink data-hovered:border-accent/50 flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-[12.5px]'

export const LISTBOX_ITEM =
  'text-ink data-focused:bg-card data-selected:text-accent cursor-default rounded px-2 py-1 text-[12.5px] outline-none'

export const POPOVER = 'border-line bg-panel w-(--trigger-width) rounded border shadow-xl'

/** Small-caps section heading used across request/response panels. */
export const SectionTitle = ({ children }: { readonly children: ReactNode }) => (
  <h3 className='text-muted text-[10.5px] font-semibold tracking-widest uppercase'>{children}</h3>
)
