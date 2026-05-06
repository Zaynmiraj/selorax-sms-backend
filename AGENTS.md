# Repository Guidelines

## Project Structure & Module Organization

SeloraX Messaging is a standalone Node/Express SMS microservice. `index.js` boots Express, connects MySQL, and starts the scheduler and campaign sender. Route registration lives in `startup/routes.js`; database setup is in `startup/db.js`. HTTP handlers are grouped under `routers/`, database access under `models/`, background jobs and platform/SMS integrations under `services/`, middleware under `middlewares/`, helpers under `utils/`, and ordered SQL changes under `migrations/`. SMS provider adapters live in `services/sms-providers/`.

## Build, Test, and Development Commands

- `yarn dev`: run `nodemon index.js` for local development.
- `yarn start`: run the service with Node.
- `yarn start:bun`: run the service with Bun when that runtime is available.
- `yarn build`: placeholder only; this CommonJS service has no build step.

Before running locally, create `.env` from `.env.example` and configure MySQL, platform credentials, and SMS provider settings. Apply SQL files in `migrations/` manually and in numeric order.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`) and keep the existing 4-space indentation. Prefer async functions with `asyncMiddleware` for route handlers and `connection.promise().query()` for MySQL calls. Keep route files resource-oriented, for example `routers/campaigns.js`, and place shared business logic in `models/` or `services/` rather than duplicating it in routers. Use snake_case for database columns and request fields that map directly to tables; use camelCase for local JavaScript functions.

## Testing Guidelines

No automated test framework is currently configured. For changes, at minimum run `yarn dev` or `yarn start` and verify `/health` plus any affected API route, webhook path, scheduler job, or campaign flow. If adding tests, prefer focused integration tests around routers/models and document the new command in `package.json`.

## Commit & Pull Request Guidelines

Recent history mostly uses short messages such as `updated work`, with one conventional entry (`feat: full SMS app redesign ...`). Prefer concise, imperative commits with a useful scope, for example `fix: guard campaign credit deduction` or `feat: add webhook retry logging`.

Pull requests should include a short summary, affected routes/jobs/tables, migration notes if SQL changes are included, environment variable changes, and manual verification steps. Include screenshots only when the dashboard or merchant-facing behavior changes.

## Security & Configuration Tips

Do not commit real `.env` values, SMS API keys, client secrets, JWT secrets, or webhook signing secrets. Preserve raw-body handling in `startup/routes.js`; webhook HMAC verification depends on it. Be careful with credit updates and purchases: guarded SQL updates prevent negative SMS balances and duplicate crediting.
