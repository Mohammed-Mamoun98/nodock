# Layouts

There is no app shell component yet. The only layout is the single-page shell rendered by
`apps/web` (M1 scaffold), plus the root HTML document.

## Root document (`apps/web/index.html`)

- Full source:

```html
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>nodock</title>
  </head>
  <body class="bg-neutral-950 text-neutral-100 antialiased">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

## App shell (`apps/web/src/App.tsx`)

Renders a single centred column: header row (product name + version label) and one
control-plane status card. No nav, sidebar, header bar, or footer exists yet — the plan's
dashboard shell (top bar + left rail + canvas/grid + service detail) is still to be built.

## Entry (`apps/web/src/main.tsx`)

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```
