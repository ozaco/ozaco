import { Button, DropZone, FileTrigger, Input, Label, TextField } from 'react-aria-components'

import { addFiles, formatBytes, moveFile, removeFile, renameField, totalSize } from '../lib'
import type { UploadFile } from '../lib'

import { ArrowDownIcon, ArrowUpIcon, FileIcon, TrashIcon, UploadIcon } from './icons'

/**
 * Attach-files section: FileTrigger + DropZone feeding the immutable lib/upload list.
 * Any attached file switches the request to multipart (fields first, then files).
 */
export const FileAttach = ({
  files,
  onChange,
}: {
  readonly files: readonly UploadFile[]
  readonly onChange: (files: readonly UploadFile[]) => void
}) => (
  <div className='flex flex-col gap-2'>
    <DropZone
      aria-label='Drop files to attach'
      className='border-line data-drop-target:border-accent data-drop-target:bg-accent/5 flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2.5'
      onDrop={event => {
        void (async () => {
          const fileItems = event.items.flatMap(item => (item.kind === 'file' ? [item] : []))
          const dropped = await Promise.all(fileItems.map(item => item.getFile()))

          if (dropped.length > 0) {
            onChange(addFiles(files, dropped))
          }
        })()
      }}>
      <span className='text-muted flex items-center gap-2 text-[12.5px]'>
        <UploadIcon />
        Drop files here, or
      </span>
      <FileTrigger
        allowsMultiple
        onSelect={selected => {
          if (selected !== null && selected.length > 0) {
            onChange(addFiles(files, selected))
          }
        }}>
        <Button className='border-line data-hovered:border-accent data-hovered:text-accent rounded-md border px-2.5 py-1 text-[12.5px]'>
          Browse files
        </Button>
      </FileTrigger>
    </DropZone>

    {files.length === 0 ? null : (
      <ul className='flex flex-col gap-1'>
        {files.map((entry, index) => (
          <li
            key={entry.id}
            className='border-line bg-surface flex items-center gap-2 rounded-md border px-2 py-1'>
            <FileIcon className='text-muted shrink-0' />
            <TextField
              aria-label={`Multipart field name for ${entry.file.name}`}
              className='w-24 shrink-0'
              onChange={value => onChange(renameField(files, entry.id, value))}
              value={entry.field}>
              <Label className='sr-only'>Field</Label>
              <Input className='border-line bg-card text-ink w-full rounded border px-1.5 py-0.5 font-mono text-[12px]' />
            </TextField>
            <span className='text-ink min-w-0 flex-1 truncate font-mono text-[12px]'>
              {entry.file.name}
            </span>
            <span className='text-muted shrink-0 text-[11.5px]'>
              {formatBytes(entry.file.size)}
            </span>
            <Button
              aria-label={`Move ${entry.file.name} up`}
              className='text-muted data-hovered:text-ink rounded p-0.5 data-disabled:opacity-30'
              isDisabled={index === 0}
              onPress={() => onChange(moveFile(files, entry.id, -1))}>
              <ArrowUpIcon />
            </Button>
            <Button
              aria-label={`Move ${entry.file.name} down`}
              className='text-muted data-hovered:text-ink rounded p-0.5 data-disabled:opacity-30'
              isDisabled={index === files.length - 1}
              onPress={() => onChange(moveFile(files, entry.id, 1))}>
              <ArrowDownIcon />
            </Button>
            <Button
              aria-label={`Remove ${entry.file.name}`}
              className='text-muted data-hovered:text-danger rounded p-0.5'
              onPress={() => onChange(removeFile(files, entry.id))}>
              <TrashIcon />
            </Button>
          </li>
        ))}
      </ul>
    )}

    {files.length > 1 ? (
      <div className='text-muted text-[11.5px]'>
        {files.length} files · {formatBytes(totalSize(files))} total
      </div>
    ) : null}
  </div>
)
