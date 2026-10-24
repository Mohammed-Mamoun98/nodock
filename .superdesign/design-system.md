# nodock — Design System

## Product context

nodock is a lightweight self-hosted PaaS with a Railway-like UX for **one 2 GB / 1 vCPU VPS**.
Two containers (nodock + Caddy), no Postgres, no Redis. Builds happen in **GitHub Actions**,
not on the server: nodock pulls the finished image from GHCR, runs it, routes to it, and reports
status. Single admin, authenticated with a GitHub OAuth App and an allowlisted login.

Core promise: the control plane stays genuinely small. The UI should feel like a **precise
operations console**, not a marketing dashboard — and it should occasionally prove its own
thesis (the left rail shows the control plane's own memory).

## What the dashboard must communicate

| Job | What the user needs to see in one glance |
|---|---|
| "Is my stuff up?" | Per-service state, last deploy age, live URL |
| "What just happened?" | Latest deployment row: commit, duration, link to the Actions run |
| "Why did it break?" | Failure reason in plain words + the exact fix ("pull 401 · add GHCR_TOKEN") |
| "Ship the new commit" | One primary action per card; optimistic feedback |
| "Roll it back" | Prior deployments reachable, rollback one click away |
| "What is it running with?" | Env vars per environment, secrets masked, redeploy hint when dirty |

Build logs live on GitHub, not here. Deployment rows must therefore link out to the exact
Actions run — the UI never pretends it owns build output.

## Screen structure

```
top bar (56px)      product mark · project switcher · environment pill · GHCR status · avatar
left rail (248px)   PROJECTS (with service counts) · ENVIRONMENTS (with counts) · control-plane footer
canvas              service cards on a 24px dot grid, 1px connection lines to the caddy/ingress node
detail panel (400px) host + tabs (Deployments | Logs | Variables | Settings) + deploy history + log stream
```

Canvas is the spatial view of a project's services; the detail panel is the drill-down for the
selected service. Selection is expressed by a lime top border on the card, not by a fill change.

## Deployment states (exact vocabulary)

`queued` · `pulling` · `starting` · `healthchecking` · `switching` · `live` · `failed` · `cancelled`

UI label mapping:
- `queued` / `pulling` / `starting` / `healthchecking` / `switching` → **building** or the literal
  step name when the row has space; amber dot, `pulse-dot` animation.
- `live` → **live**; lime dot, no animation.
- `failed` → **failed**; red dot, plus a one-line cause and remedy.
- `cancelled` → **cancelled** (`superseded` when a newer build displaced it); steel dot.
- Manually stopped container → **stopped**; hollow steel ring, never a filled dot.

Color is never the only signal: every state also has its word and (for in-progress) motion.

## Visual language

Dark technical console. Near-black canvas, slightly lighter surfaces, hairline borders, one
lime accent carrying "alive/primary", amber for in-flight, red for broken, steel for inert.
No gradients, no glow, no soft shadows, no glassmorphism. Depth comes from 1px borders and
surface steps, not elevation.

- **Colors:** `canvas #0B0C0D`, `surface #14171A`, `surface-2 #1B1F23`, `line #252A2F`,
  `text #E8EAE9`, `text-dim #8B949A`, `lime #C8FA5F`, `lime-ink #0B0C0D`, `amber #F5B544`,
  `red #FF6B5A`, `steel #5F6B72`.
- **Type:** Inter 400/500/600 for prose and UI labels; JetBrains Mono 400/500 for anything a
  machine produced — hosts, SHAs, branches, durations, counts, status words, logs. Scale
  `11/13/14/15px`. Tabular numerals everywhere numbers can change.
- **Geometry:** radii 4px chips/nodes, 6px buttons/inputs, 8px cards/panels. Borders always 1px.
  Rows 32px. Buttons 28px. No `rounded-full` except status dots and the avatar.
- **Density:** information-dense but breathable — 16/20px card padding, 12px gutters, no giant
  hero areas, no oversized page titles.
- **Motion:** `pulse-dot` 1.6s amber for in-progress, `blink` 1s lime cursor in the log stream,
  `transition-colors` for everything else. Nothing bounces, scales, or springs.

## Component conventions

- **Primary action** = filled lime with `lime-ink` text. **Secondary** = 1px `line` border on
  `surface`, text at `text`. Tertiary = bare text/icon at `text-dim` → `text` on hover.
- **Status chip** = 9px uppercase mono, 1px border at 30% of the state color, transparent fill.
- **Service card** = name (sans medium) + status row + repo/branch@sha (mono, dim) + footer
  action row above a 1px divider. 252×176 minimum.
- **Tabs** = underline at `lime` 2px for active; inactive text `text-dim`.
- **Log stream** = `canvas` background, 1px border, 8px radius, mono 11px, timestamps at 50%
  opacity, bottom rule with a `following` affordance.
- **Empty/failed states always name the fix.** Never "Something went wrong" — say
  `pull 401 · add GHCR_TOKEN`.

## Copy voice

Lowercase product nouns (`nodock`, `caddy`), sentence-case labels, no exclamation marks,
no marketing adjectives. Numbers are always exact or omitted — `42s ago`, `1m 12s`, `92 MB`.

## Hard constraints designs must respect

- Single admin, single default environment; the switcher exists but keeps child environments rare.
- No CPU/RAM charts, no metrics dashboards, no auto-scaling UI — v1 has none of that data.
- No volumes/backups UI inside a service (deployments lose local state; the plan says so).
- The UI must degrade to a plain grid when the viewport is narrow — the canvas is a layout
  choice, not a requirement for correctness.
- Any host/URL shown must look copyable (mono + copy affordance).
