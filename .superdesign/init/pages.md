# Pages

## / (SPA shell)

Entry: `apps/web/src/App.tsx`

Dependencies:
- `apps/web/src/main.tsx`
  - `apps/web/src/index.css`
- `apps/web/src/index.css`
- `apps/web/index.html`

Renders: header (product name + version), one control-plane status card fed by
`GET /healthz` (status / database / bun version), and a placeholder line about later
milestones. No nav, no data tables, no service UI.

## Notes for design work

The dashboard being designed on the canvas does not exist in the codebase yet — there is
nothing to reproduce. Designs must therefore define the shell themselves: top bar,
left rail (projects + environments), service canvas/grid, and the service detail panel
with Deployments / Logs / Variables / Settings tabs.
