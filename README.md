# Scribble

A quiet A4-landscape drawing prompt. Each completed part reveals the next line
of copy immediately, so the whole five can be drawn without lifting. When the
sequence is complete, the Worker saves one canonical 1 pt SVG path in
Cloudflare D1. `/5` lists every kept five with its timestamp and bulk export.

## Local development

```bash
npm ci
npm run dev
```

The app uses a local D1 database during development. Apply its migration once:

```bash
npm exec -- wrangler d1 migrations apply scribble-db --local
```

## Checks

```bash
npm run typecheck
npm run lint
npm test
```

## Deploy

Authenticate with the Cloudflare account that owns the configured D1 database,
apply any pending migrations, build, and deploy:

```bash
npm exec -- wrangler whoami
npm exec -- wrangler d1 migrations apply scribble-db --remote
npm run build
npm exec -- wrangler deploy --strict
```
