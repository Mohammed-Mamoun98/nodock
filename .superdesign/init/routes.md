# Routes

No client router is installed. `apps/web` is a single-screen SPA (M1 scaffold); the Bun
server serves `apps/web/dist/index.html` for any non-API path.

## Implemented

| Path | Renderer | Notes |
|---|---|---|
| `/*` (everything not `/api/*`, `/auth/*`, `/webhooks/*`, `/internal/*`, `/healthz`, `/metrics-lite`) | `apps/web/src/App.tsx` | SPA shell; API routes 404/501 today |

## Planned (from the v1 plan, not yet routed)

| Path | Purpose |
|---|---|
| `/login` | "Continue with GitHub" (OAuth App, allowlisted login) |
| `/` | Projects list + create project |
| `/projects/:id` | Environment switcher + grid of service cards |
| `/projects/:id/services/:serviceId` | Service detail: Deployments / Logs / Variables / Settings tabs |
| `/settings` | Base domain, GitHub connection, GHCR pull-token status |

Server-side routes that already exist: `GET /healthz`, `GET /metrics-lite`.
