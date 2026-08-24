# Scribble

A quiet, full-screen drawing prompt. Each accepted gesture reveals the next
line of copy. When the sequence is complete, the Worker converts the validated
point data into canonical SVG and saves it in Cloudflare D1.

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

Create the production D1 database, replace the placeholder database ID in
`wrangler.jsonc`, apply migrations remotely, build, and deploy:

```bash
npm exec -- wrangler d1 create scribble-db
npm exec -- wrangler d1 migrations apply scribble-db --remote
npm run build
npm exec -- wrangler deploy
```
