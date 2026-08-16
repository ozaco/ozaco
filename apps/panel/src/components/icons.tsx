import type { ReactNode, SVGProps } from 'react'

/** Inline SVG icon set — 16px stroke glyphs, `currentColor`, zero external assets. */

type IconProps = SVGProps<SVGSVGElement>

const Svg = ({ children, ...props }: IconProps & { readonly children: ReactNode }) => (
  <svg
    aria-hidden='true'
    fill='none'
    height={14}
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={1.5}
    viewBox='0 0 16 16'
    width={14}
    {...props}>
    {children}
  </svg>
)

export const SearchIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx='7' cy='7' r='4.5' />
    <path d='m10.5 10.5 3 3' />
  </Svg>
)

export const CloseIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='m4 4 8 8m0-8-8 8' />
  </Svg>
)

export const CopyIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect height='9' rx='1.5' width='9' x='5.5' y='5.5' />
    <path d='M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1' />
  </Svg>
)

export const CheckIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='m2.5 8.5 3.5 3.5 7.5-8' />
  </Svg>
)

export const ChevronIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='m6 3.5 4.5 4.5L6 12.5' />
  </Svg>
)

export const GearIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx='8' cy='8' r='2.25' />
    <path d='M8 1.5v2m0 9v2M14.5 8h-2m-9 0h-2m11.1-4.6-1.4 1.4M4.8 11.2l-1.4 1.4m9.2 0-1.4-1.4M4.8 4.8 3.4 3.4' />
  </Svg>
)

export const PlayIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='M4.5 3v10l8-5z' />
  </Svg>
)

export const StopIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect height='8' rx='1' width='8' x='4' y='4' />
  </Svg>
)

export const UploadIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='M8 10.5v-8m0 0L4.5 6M8 2.5 11.5 6M2.5 12.5v1h11v-1' />
  </Svg>
)

export const FileIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='M4 1.5h5L12.5 5v9.5h-9V1.5Z' />
    <path d='M9 1.5V5h3.5' />
  </Svg>
)

export const TrashIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='M2.5 4h11M6 4V2.5h4V4m-6.5 0 .5 9.5h6l.5-9.5' />
  </Svg>
)

export const ArrowUpIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='M8 13V3m0 0L4 7m4-4 4 4' />
  </Svg>
)

export const ArrowDownIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='M8 3v10m0 0 4-4m-4 4-4-4' />
  </Svg>
)

export const BoltIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='M9 1.5 3.5 9H7l-.5 5.5L12 7H8.5z' />
  </Svg>
)

export const RefreshIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3' />
  </Svg>
)

export const ClockIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx='8' cy='8' r='5.5' />
    <path d='M8 5v3.2l2.2 1.3' />
  </Svg>
)

export const MarkIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='M8 1.5 14.5 8 8 14.5 1.5 8Z' />
    <path d='M8 5.5 10.5 8 8 10.5 5.5 8Z' />
  </Svg>
)

export const SunIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx='8' cy='8' r='3' />
    <path d='M8 1.5v1.5m0 10v1.5M14.5 8H13M3 8H1.5m11.1-4.6-1.1 1.1M4 12l-1.1 1.1m9.7 0L11.5 12M4 4 2.9 2.9' />
  </Svg>
)

export const MoonIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z' />
  </Svg>
)

export const MonitorIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect height='8' rx='1' width='12' x='2' y='2.5' />
    <path d='M6 13.5h4m-2-3v3' />
  </Svg>
)

export const BookIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='M2.5 2.5h4.5a1 1 0 0 1 1 1v10a1 1 0 0 0-1-1H2.5Z' />
    <path d='M13.5 2.5H9a1 1 0 0 0-1 1v10a1 1 0 0 1 1-1h4.5Z' />
  </Svg>
)

export const PlusIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d='M8 3v10M3 8h10' />
  </Svg>
)
