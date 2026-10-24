# Extractable components

Nothing is extractable yet — the codebase has exactly one screen and no shared components.
Recording the candidates so the first real implementation can be extracted later.

## Layout Components (candidates)

### AppShell
- Source: `apps/web/src/App.tsx` (will be split out)
- Category: layout
- Description: Top bar + left rail + content + service detection panel.
- Extractable props: `projectName`, `projectCount`, `environmentName`, `serviceCount`, `controlPlaneMb`
- Hardcoded: logo mark (2px lime square), nav labels, rail widths, icons.

### TopBar
- Source: not implemented
- Category: layout
- Description: Product mark, project switcher, environment pill, GHCR status, avatar.
- Extractable props: `activeProject`, `activeEnvironment`, `ghcrState` (`ok` | `warn` | `error`), `avatarUrl`
- Hardcoded: `⌘K` hint, icon names, heights.

## Basic Components (candidates)

### StatusDot
- Source: not implemented
- Category: basic
- Description: 6px dot encoding deployment state.
- Extractable props: `state` (`live` | `building` | `failed` | `stopped`)
- Hardcoded: color mapping (`lime`/`amber`/`red`/`steel`), pulse animation for `building`.

### ServiceCard
- Source: not implemented
- Category: basic
- Description: 252×176 card: name, status, repo, branch@sha, one primary action.
- Extractable props: `name`, `state`, `repo`, `branch`, `sha`, `actionLabel`, `selected`
- Hardcoded: card width/min-height, footer divider, mono type scale.

### DeployRow
- Source: not implemented
- Category: basic
- Description: Deployment history row: #id, status chip, sha@branch, age, duration, Actions link.
- Extractable props: `deploymentId`, `status`, `sha`, `branch`, `age`, `duration`, `runUrl`
- Hardcoded: chip colors, 16-unit id column, tabular numerals.
