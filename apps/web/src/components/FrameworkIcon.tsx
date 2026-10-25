/**
 * One 16px mark per framework detection can name, drawn in the same stroke
 * language as `Icon` so a framework tag reads as part of the same set.
 *
 * The brands are simplified on purpose: at 14px a faithful logo is a smudge.
 * Keys are the `framework` values `detectFramework` emits, so a new framework
 * there shows up as `unknown` here until it gets a mark of its own.
 */
const marks = {
  /** Containers stacked on a hull — the whale, without the whale. */
  dockerfile: (
    <>
      <rect x="3.2" y="5.6" width="2.8" height="2.8" rx="0.5" />
      <rect x="6.4" y="5.6" width="2.8" height="2.8" rx="0.5" />
      <rect x="6.4" y="2.5" width="2.8" height="2.8" rx="0.5" />
      <path d="M1.7 9.3h11.5v.5a3.5 3.5 0 0 1-3.5 3.5H5.2a3.5 3.5 0 0 1-3.5-3.5z" />
    </>
  ),
  next: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.7 11.2V5.4l4.9 5.9" />
    </>
  ),
  astro: (
    <path d="M8 2.5c.45 2.6 1.9 4.05 4.5 4.5-2.6.45-4.05 1.9-4.5 4.5-.45-2.6-1.9-4.05-4.5-4.5 2.6-.45 4.05-1.9 4.5-4.5z" />
  ),
  vite: <path d="M9.2 2.3L4.1 8.9h3.1L6.8 13.7l5.1-6.6H8.8z" />,
  nuxt: (
    <>
      <path d="M1.9 12.3L6.1 4.9l4.2 7.4z" />
      <path d="M7 12.3l3.2-5.7 3.9 5.7" />
    </>
  ),
  sveltekit: (
    <path d="M10.9 5.2c-.6-1.2-2-1.8-3.3-1.4L5 4.9c-1.3.4-1.9 1.7-1.5 2.9.4 1.1 1.5 1.5 2.8 1.7 1.4.2 2.4.7 2.6 1.8.2 1.3-.6 2.4-1.9 2.8l-2.6.9c-1.3.4-2.7-.2-3.3-1.4" />
  ),
  cra: (
    <>
      <circle cx="8" cy="8" r="1.3" />
      <ellipse cx="8" cy="8" rx="5.5" ry="2.1" transform="rotate(45 8 8)" />
      <ellipse cx="8" cy="8" rx="5.5" ry="2.1" transform="rotate(-45 8 8)" />
    </>
  ),
  go: (
    <>
      <circle cx="8" cy="8.7" r="4.8" />
      <circle cx="6.2" cy="8.2" r=".65" fill="currentColor" stroke="none" />
      <circle cx="9.8" cy="8.2" r=".65" fill="currentColor" stroke="none" />
      <path d="M4.6 4.9L3.6 3.9M11.4 4.9l1-1" />
    </>
  ),
  python: <path d="M3.4 3.6h5.4a2.6 2.6 0 1 1 0 5.2H7.2a2.6 2.6 0 1 0 0 5.2h5.4" />,
  php: (
    <>
      <ellipse cx="8" cy="8" rx="5.9" ry="4.1" />
      <path d="M5.8 10.2V5.9h1.9a1.45 1.45 0 0 1 0 2.9H5.8" />
    </>
  ),
  ruby: (
    <>
      <path d="M4.7 2.9h6.6l2.5 3.4L8 13.6 2.2 6.3z" />
      <path d="M2.2 6.3h11.6M4.7 2.9L8 13.6l3.3-10.7" />
    </>
  ),
  /** No box: the mark already sits in a tile, and a box inside a box is noise. */
  unknown: (
    <>
      <path d="M5.6 6a2.4 2.4 0 1 1 3.3 2.7c-.5.2-.9.7-.9 1.3v.4" />
      <circle cx="8" cy="12.6" r=".55" fill="currentColor" stroke="none" />
    </>
  ),
} as const;

/**
 * Renders nothing before there is something to draw: an empty tile while the
 * repository is being inspected, rather than a question mark that would claim
 * `unknown` before anyone looked.
 */
export function FrameworkIcon({
  framework,
  className = '',
}: {
  framework?: string | null;
  className?: string;
}) {
  if (!framework) return null;
  const mark = marks[framework as keyof typeof marks] ?? marks.unknown;

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
      {mark}
    </svg>
  );
}
