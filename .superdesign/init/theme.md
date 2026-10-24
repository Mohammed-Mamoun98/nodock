# Theme

## Part 1 — Compact token summary

### Where the tokens live
- **Code:** Tailwind v4, configured entirely in CSS (`apps/web/src/index.css`) via `@theme`.
  Only fonts are defined there today — no color tokens have been committed yet.
- **Canvas design (chosen visual direction, draft `be90196f` v2):** dark technical console
  with a lime accent. These are the values designs must use until they are ported to CSS.

### Color (canvas design direction)
| Token | Value | Use |
|---|---|---|
| `canvas` | `#0B0C0D` | app/canvas background, log stream background |
| `surface` | `#14171A` | top bar, rails, cards, panels |
| `surface-2` | `#1B1F23` | hovered rows, inputs, secondary chips |
| `line` | `#252A2F` | 1px borders/dividers, dot-grid, connection lines |
| `text` | `#E8EAE9` | primary text |
| `text-dim` | `#8B949A` | labels, metadata, secondary text |
| `lime` | `#C8FA5F` | live/ok, primary CTA fill, active tab underline, focus |
| `lime-ink` | `#0B0C0D` | text on lime |
| `amber` | `#F5B544` | building/deploying, warnings |
| `red` | `#FF6B5A` | failed, destructive |
| `steel` | `#5F6B72` | stopped/neutral state, disabled |

### Typography
- Sans: `Inter` 400/500/600 — UI text, headings, buttons.
- Mono: `JetBrains Mono` 400/500 — hosts, SHAs, timings, status words, logs, counts.
- Scale: `11px/1.4` mono-xs, `13px/1.5` ui-sm, `14px/1.5` ui-base, `15px/1.5` ui-lg.
- Numbers use tabular figures.

### Geometry & spacing
- Radii: `4px` (chips/nodes), `6px` (buttons, inputs, switchers), `8px` (cards, panels).
- Border: always `1px` `line`; accent borders use `lime/30` or `lime`.
- Density: rows `h-8` (32px), top bar `56px`, buttons `h-7` (28px) / `h-[28px]`.
- Fixed widths: left rail `248px`, right detail panel `400px`, service card `252×176` min.
- Gaps: `1.5`/`2` inside groups, `4`/`5` between sections; panel padding `p-4`/`p-5`.
- Canvas: 24px dot grid, nodes positioned absolutely with 1px connection lines to the
  ingress (caddy) node.

### Motion
- `pulse-dot` — 1.6s ease-out infinite, amber, for in-progress states.
- `blink` — 1s step-end infinite, lime block cursor in the log stream.
- Everything else: `transition-colors` only. No bounce, no spring, no scale animations.

## Part 2 — Raw source

### `apps/web/src/index.css`

```css
@import 'tailwindcss';

/* System font stack: no webfont request, no layout shift. */
@theme {
  --font-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
}
```

### Canvas design Tailwind config (draft `be90196f` v2, for fidelity)

```js
tailwind.config = {
  theme: {
    extend: {
      colors: {
        canvas: '#0B0C0D',
        surface: '#14171A',
        'surface-2': '#1B1F23',
        line: '#252A2F',
        text: '#E8EAE9',
        'text-dim': '#8B949A',
        lime: '#C8FA5F',
        'lime-ink': '#0B0C0D',
        amber: '#F5B544',
        red: '#FF6B5A',
        steel: '#5F6B72',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      fontSize: {
        'mono-xs': ['11px', '1.4'],
        'ui-sm': ['13px', '1.5'],
        'ui-base': ['14px', '1.5'],
        'ui-lg': ['15px', '1.5'],
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.6s ease-out infinite',
        blink: 'blink 1s step-end infinite',
      },
    },
  },
};
```
