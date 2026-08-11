# React + TypeScript + Vite

## VoltTrade Cloud — ops notes

- **Schema changes (v5 #24):** never hand-apply SQL. Edit `db/schema.ts`, then
  `npm run db:generate` (writes `db/migrations/`) and `npm run db:migrate`
  against the target database. Timescale schema changes go in
  `db/timescale/001_init.sql` (idempotent; notes for existing deployments inline).
- **Tests (v5 #23):** `npm test` (vitest, `tests/`) — codec offset/stride,
  CSV formula-injection guard, poller backoff/transport classification,
  offline thresholds, G30 unit-hint normalization. E2E harnesses:
  `npx tsx scripts/test-esmu-e2e.ts`, `scripts/test-pv-e2e.ts`.
- **Destructive scripts** (`cleanup-*`, `clear-telemetry`, `repair-orphans`)
  refuse to run against a non-local `DATABASE_URL` unless `ALLOW_UNSAFE_PROD=1`
  is set (v5 #22).
- **Optional hardening env:** `API_TOKEN` (Bearer guard on /api/trpc/*) +
  `VITE_API_TOKEN` (frontend), `MQTT_USERNAME`/`MQTT_PASSWORD` (broker auth),
  `MQTT_BIND_HOST`, `MQTT_AUTO_PROVISION=0` (disable zero-touch onboarding).
- **Day/timezone policy (v5 #8):** all server-side "day" bucketing is UTC
  (epoch-based); the browser renders in its local tz. One conversion point.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
