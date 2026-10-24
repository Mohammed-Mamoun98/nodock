const paths = {
  plus: <path d="M8 3v10M3 8h10" />,
  'chevron-down': <path d="M4 6l4 4 4-4" />,
  'more-horizontal': (
    <>
      <circle cx="4" cy="8" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="12" cy="8" r="1" />
    </>
  ),
  copy: (
    <>
      <rect x="6" y="6" width="7" height="7" rx="1.5" />
      <path d="M10 4.5A1.5 1.5 0 0 0 8.5 3H4.5A1.5 1.5 0 0 0 3 4.5v4A1.5 1.5 0 0 0 4.5 10" />
    </>
  ),
  check: <path d="M3 8.5l3.2 3L13 5" />,
  'alert-triangle': (
    <>
      <path d="M8 3.5L14 13H2L8 3.5z" />
      <path d="M8 7v2.5M8 11.2v.3" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M2 2l12 12" />
      <path d="M6.3 6.4A1.8 1.8 0 0 0 8 9.8" />
      <path d="M1.5 8S4 3.5 8 3.5c1 0 1.9.3 2.7.7M13.4 6.2c.7.9 1.1 1.8 1.1 1.8S12 12.5 8 12.5c-.7 0-1.3-.1-1.9-.4" />
    </>
  ),
  trash: <path d="M3 5h10M6.5 5V3.5h3V5M5 5l.6 8h4.8L11 5" />,
  pause: (
    <>
      <rect x="5" y="4" width="2" height="8" rx="0.5" />
      <rect x="9" y="4" width="2" height="8" rx="0.5" />
    </>
  ),
  'arrow-up-right': <path d="M5 11L11 5M6.5 5H11v4.5" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      {paths[name]}
    </svg>
  );
}
