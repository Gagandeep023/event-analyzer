# 03. Architecture

## Package identity

| | |
|---|---|
| **npm name** | `@gagandeep023/event-analyzer` |
| **version** | `0.1.0` |
| **repository** | `git@github.com-personal:Gagandeep023/event-analyzer.git` |
| **local path** | `~/Documents/coffee-project/Gagandeep023/event-analyzer/` |
| **license** | MIT |
| **output** | Dual CJS + ESM via tsup, with `.d.ts` per entry |

The unscoped name `event-analyzer` is taken on npm; the scoped name is free. It pairs deliberately with the existing `@gagandeep023/log-analyzer`.

### Standalone by design

This repository has its own git remote, its own `package.json`, its own CI. It is **not** inside `portfolio/npm-packages/`. It must build, test, publish and demo with every other repository absent from the machine. Consumers, including the portfolio, come later and depend on the published tarball.

## Dependency direction

```
                    ┌──────────┐
                    │  types   │   zero runtime, declarations only
                    └────┬─────┘
          ┌──────────────┼──────────────┬──────────────┐
          ▼              ▼              ▼              ▼
     ┌─────────┐   ┌─────────┐   ┌──────────┐   ┌──────────┐
     │  core   │   │   sdk   │   │ frontend │   │ backend  │
     │ 0 deps  │   │ 0 deps  │   │  react   │   │ express  │
     └────┬────┘   └─────────┘   │ recharts │   └────▲─────┘
          │                      └──────────┘        │
          └──────────────────────────────────────────┘
                     backend imports core
```

No cycles. `core` never imports `sdk`, `backend` or `frontend`.

`core` and `sdk` ship with an empty `dependencies` block. `express`, `react`, `react-dom` and `recharts` are **optional** peers, so installing the package purely for its analysis engine pulls in nothing.

## Repository layout

```
event-analyzer/
├── src/
│   ├── index.ts                  root export
│   ├── types/                    doc 05
│   ├── core/                     doc 06
│   ├── sdk/                      doc 07
│   ├── backend/                  doc 08
│   ├── frontend/                 doc 09
│   └── __tests__/                doc 11
├── examples/
│   ├── server.ts                 runnable ingestion + query server
│   ├── seed.ts                   deterministic synthetic event generator
│   └── app/                      vite demo mounting the dashboard
├── docs/                         this directory
├── dist/                         build output, gitignored
├── package.json
├── tsup.config.ts
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.mjs
├── .npmignore
├── LICENSE
├── GUIDE.md                      long-form usage, shipped in the tarball
└── README.md
```

## Exports map

Five entry points plus a stylesheet.

```json
{
  "name": "@gagandeep023/event-analyzer",
  "version": "0.1.0",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.js"
    },
    "./core": {
      "types": "./dist/core/index.d.ts",
      "import": "./dist/core/index.mjs",
      "require": "./dist/core/index.js"
    },
    "./sdk": {
      "types": "./dist/sdk/index.d.ts",
      "import": "./dist/sdk/index.mjs",
      "require": "./dist/sdk/index.js"
    },
    "./backend": {
      "types": "./dist/backend/index.d.ts",
      "import": "./dist/backend/index.mjs",
      "require": "./dist/backend/index.js"
    },
    "./frontend": {
      "types": "./dist/frontend/index.d.ts",
      "import": "./dist/frontend/index.mjs",
      "require": "./dist/frontend/index.js"
    },
    "./frontend/styles.css": "./dist/frontend/EventAnalyzerDashboard.css",
    "./types": {
      "types": "./dist/types/index.d.ts",
      "import": "./dist/types/index.mjs",
      "require": "./dist/types/index.js"
    }
  },
  "files": ["dist", "GUIDE.md"],
  "dependencies": {},
  "peerDependencies": {
    "express": "^4.0.0 || ^5.0.0",
    "react": "^18.0.0 || ^19.0.0",
    "react-dom": "^18.0.0 || ^19.0.0",
    "recharts": "^2.0.0 || ^3.0.0"
  },
  "peerDependenciesMeta": {
    "express":   { "optional": true },
    "react":     { "optional": true },
    "react-dom": { "optional": true },
    "recharts":  { "optional": true }
  },
  "publishConfig": { "access": "public" }
}
```

> **Consumer note.** A backend importing `@gagandeep023/event-analyzer/backend` needs `"module": "Node16"` (or `NodeNext`) in its tsconfig for subpath exports to resolve. This is the same constraint `@gagandeep023/api-gateway` hit.

## Build configuration

### tsup.config.ts

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index':          'src/index.ts',
    'core/index':     'src/core/index.ts',
    'sdk/index':      'src/sdk/index.ts',
    'backend/index':  'src/backend/index.ts',
    'frontend/index': 'src/frontend/index.ts',
    'types/index':    'src/types/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['express', 'react', 'react-dom', 'recharts'],
});
```

Build script copies the stylesheet, matching the `api-gateway` pattern:

```json
"build": "tsup && cp src/frontend/EventAnalyzerDashboard.css dist/frontend/EventAnalyzerDashboard.css"
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

### Pinned dependency: vitest

`vitest` is pinned to an **exact** `4.0.18` rather than `^4.0.18`.

The caret range resolves to 4.1.11, whose optional peer chain through
`@vitest/browser-playwright` triggers a null-dereference bug in npm 10.9.4's
arborist (`Cannot read properties of null (reading 'edgesOut')`), and the install
fails outright. 4.0.18 is the version proven working in `api-gateway`.

Revisit when npm or vitest ships a fix. Leave a comment on the pin so it is not
silently widened back to a caret.

### .npmignore

```
src/
docs/
examples/
tsconfig.json
tsup.config.ts
eslint.config.mjs
vitest.config.ts
*.test.ts
.github/
coverage/
.DS_Store
```

## Module responsibilities

| Module | Owns | Never does |
|---|---|---|
| `types` | The shared contract every module agrees on | Contains runtime code |
| `core` | All analysis. Pure functions, events in, results out. | I/O, clock reads, HTTP |
| `sdk` | Capture, batching, delivery, retry, session lifecycle | Analysis |
| `backend` | Validation, persistence, routing, serialisation | Analysis (it delegates to `core`) |
| `frontend` | Rendering and query composition | Analysis, or knowing about storage |

The important line is between `core` and `backend`. `backend` reads events from a store and hands them to `core`; it never computes a funnel itself. That separation is what lets the analysis engine be used standalone against an array of events with no server at all.
