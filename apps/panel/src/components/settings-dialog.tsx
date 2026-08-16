import { useEffect, useState } from 'react'
import {
  Button,
  Dialog,
  Heading,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Popover,
  Select,
  SelectValue,
  TextField,
  ToggleButton,
} from 'react-aria-components'

import type { Theme } from '../lib'

import { ChevronIcon } from './icons'

/** Panel settings — base URL override, bearer token, theme — persisted via lib/config. */

const FIELD_INPUT =
  'border-line bg-surface text-ink w-full rounded-md border px-2.5 py-1.5 text-[13px]'

const THEMES: readonly { readonly id: Theme; readonly label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'System' },
]

const isTheme = (value: unknown): value is Theme =>
  value === 'dark' || value === 'light' || value === 'system'

export interface PanelSettings {
  readonly base: string
  readonly token: string
  readonly theme: Theme
}

export const SettingsDialog = ({
  isOpen,
  onOpenChange,
  settings,
  onSave,
}: {
  readonly isOpen: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly settings: PanelSettings
  readonly onSave: (next: PanelSettings) => void
}) => {
  const [base, setBase] = useState(settings.base)
  const [token, setToken] = useState(settings.token)
  const [theme, setTheme] = useState<Theme>(settings.theme)
  const [reveal, setReveal] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setBase(settings.base)
      setToken(settings.token)
      setTheme(settings.theme)
      setReveal(false)
    }
  }, [isOpen, settings])

  return (
    <ModalOverlay
      className='fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4'
      isDismissable
      isOpen={isOpen}
      onOpenChange={onOpenChange}>
      <Modal className='border-line bg-panel w-full max-w-md rounded-xl border shadow-2xl'>
        <Dialog className='flex flex-col gap-4 p-5 outline-none'>
          <Heading className='text-ink text-base font-semibold' slot='title'>
            Settings
          </Heading>

          <TextField className='flex flex-col gap-1' onChange={setBase} value={base}>
            <Label className='text-muted text-[12px] font-medium'>Base URL</Label>
            <Input className={`${FIELD_INPUT} font-mono`} placeholder='same origin' />
            <span className='text-muted text-[11.5px]'>
              http(s)://host:port of the ozaco server — leave empty for same origin.
            </span>
          </TextField>

          <TextField
            className='flex flex-col gap-1'
            onChange={setToken}
            type={reveal ? 'text' : 'password'}
            value={token}>
            <Label className='text-muted text-[12px] font-medium'>Bearer token</Label>
            <div className='flex items-center gap-2'>
              <Input
                className={`${FIELD_INPUT} font-mono`}
                placeholder='optional — persisted locally'
              />
              <ToggleButton
                className='border-line text-muted data-selected:text-accent data-hovered:text-ink shrink-0 rounded-md border px-2 py-1.5 text-[12px]'
                isSelected={reveal}
                onChange={setReveal}>
                {reveal ? 'hide' : 'show'}
              </ToggleButton>
            </div>
          </TextField>

          <Select
            className='flex flex-col gap-1'
            onSelectionChange={key => {
              if (isTheme(key)) {
                setTheme(key)
              }
            }}
            selectedKey={theme}>
            <Label className='text-muted text-[12px] font-medium'>Theme</Label>
            <Button className='border-line bg-surface text-ink flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-[13px]'>
              <SelectValue />
              <ChevronIcon className='text-muted rotate-90' />
            </Button>
            <Popover className='border-line bg-panel w-(--trigger-width) rounded-md border shadow-xl'>
              <ListBox className='p-1 outline-none' items={THEMES}>
                {item => (
                  <ListBoxItem
                    className='text-ink data-focused:bg-card data-selected:text-accent cursor-default rounded px-2 py-1 text-[13px] outline-none'
                    id={item.id}
                    textValue={item.label}>
                    {item.label}
                  </ListBoxItem>
                )}
              </ListBox>
            </Popover>
          </Select>

          <div className='flex justify-end gap-2 pt-1'>
            <Button
              className='border-line text-muted data-hovered:text-ink rounded-md border px-3 py-1.5 text-[13px]'
              onPress={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              className='border-accent/60 text-accent data-hovered:bg-accent/10 rounded-md border px-3 py-1.5 text-[13px] font-medium'
              onPress={() => {
                onSave({ base: base.trim().replace(/\/+$/u, ''), token: token.trim(), theme })
                onOpenChange(false)
              }}>
              Save changes
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
