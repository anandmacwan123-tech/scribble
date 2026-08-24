# Scribble

A quiet A4-landscape page for drawing fives. Recognition runs continuously and
unlocks an explicit Submit action after a five is detected, while the page stays
open for more marks. The dot grid and zoom are view-only; submitted sheets are
stored in Cloudflare D1 as one canonical 1 pt SVG path. `/5` lists every kept
sheet with its timestamp and bulk export.

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
npm exec -- wrangler deploy --strict --keep-vars
```
