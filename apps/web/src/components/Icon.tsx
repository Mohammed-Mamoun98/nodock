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
  globe: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.5z" />
    </>
  ),
  github: (
    <path d="M8 1.5a6.5 6.5 0 0 0-2.05 12.67c.32.06.44-.14.44-.31v-1.2c-1.8.39-2.18-.87-2.18-.87-.3-.75-.72-.95-.72-.95-.59-.4.04-.4.04-.4.65.05.99.67.99.67.58.99 1.52.7 1.89.54.06-.42.23-.7.41-.87-1.44-.16-2.95-.72-2.95-3.2 0-.71.25-1.29.66-1.74-.07-.16-.29-.82.06-1.71 0 0 .54-.17 1.77.66a6.1 6.1 0 0 1 3.22 0c1.23-.83 1.77-.66 1.77-.66.35.89.13 1.55.06 1.71.41.45.66 1.03.66 1.74 0 2.49-1.52 3.04-2.96 3.2.23.2.44.6.44 1.21v1.79c0 .17.12.37.45.31A6.5 6.5 0 0 0 8 1.5z" />
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6" rx="1.5" />
      <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
    </>
  ),
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
