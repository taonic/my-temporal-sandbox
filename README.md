# Temporal Sandbox

Browser-based playground for prototyping [Temporal](https://temporal.io)
workflows. Edit TypeScript in the UI, click **Run**, and the launcher
provisions a [Daytona](https://daytona.io) sandbox with a Temporal dev
server, uploads your code, runs the workflow, and gives you a signed
link to the Temporal Web UI.

The default sample is a money-transfer saga (withdraw → deposit, with a
refund-on-failure compensation). Edit it, change `AMOUNT` to `13` to
trigger the saga's failure path, or replace it with your own workflow
entirely.

## Setup

Requires Node 18+ and a `DAYTONA_KEY` env var.

```bash
npm install
npm start          # or: npm run dev   (tsx watch)
```

Open <http://localhost:8000>, edit the source if you want, and click
**Run**. The activity log streams progress; when the dev server is
healthy, an **Open Temporal UI ↗** link appears in the toolbar.

## How it works

The launcher uses Daytona's declarative `Image` API to build a custom
snapshot once, then reuses it for every sandbox:

1. **Image (built once on Daytona infra, cached as a snapshot):**
   - Base: `node:20-bookworm-slim`.
   - Temporal CLI from `temporal.download`, installed at `/usr/local/bin/temporal`.
     (The build runs on Daytona's side, so `temporal.download` is reachable
     even on tiers where the *sandbox* itself can't egress to it.)
   - `npm install` of `@temporalio/{worker,client,workflow,activity}` against
     `sandbox/package.json`, baked into `/opt/app/node_modules`.
2. **Per-Run (fast — no installs):**
   - Upload the four editor buffers (`starter.ts`, `workflows.ts`, `activities.ts`, `worker.ts`, `shared.ts`) into `/opt/app`.
   - Start `temporal server start-dev --ip 0.0.0.0 --ui-ip 0.0.0.0` and wait for `temporal operator cluster health` to pass.
   - Issue a [signed preview URL](https://www.daytona.io/docs/en/preview/#signed-preview-url) for port 8233 and surface it in the UI.
   - `pkill` and restart the worker session, then `tsx starter.ts` to kick off the workflow.

Bumping the Node base image, the Temporal CLI URL, or `sandbox/package.json`
invalidates the snapshot fingerprint and triggers a one-time rebuild.

## Sandbox lifecycle

- **Auto-stop:** 15 min of inactivity stops the sandbox.
- **Auto-delete:** 30 min after stopping, the sandbox is deleted entirely.
- **Stale ID recovery:** if you click Run after a sandbox has been reaped,
  the backend detects the 404 and transparently launches a fresh one.
- **Signed preview URL:** 4-hour TTL, token embedded in the URL — no
  extra headers needed to click into the Temporal UI.
- **Disk:** 1 GiB per sandbox.
- **Stop button:** explicit `sandbox.delete()` for immediate cleanup.

## In-browser editing

- The UI has a CodeMirror 6 editor with TypeScript syntax highlighting.
- Tabs for `starter.ts`, `workflows.ts`, `activities.ts`, `worker.ts`, `shared.ts`. A `●` marker shows files edited since the last successful Run.
- Edits live only in the browser's memory and the running Daytona sandbox
  — they are *not* persisted to your local `sandbox/*.ts` files. Reload
  the page to discard edits and reload the on-disk seed values.

## Layout

| Path | Role |
| ---- | ---- |
| [src/server.ts](src/server.ts) | Express app — serves the UI and exposes `/api/run` (SSE), `/api/files` (GET seed), `/api/stop`. |
| [src/manager.ts](src/manager.ts) | Daytona lifecycle: declarative image, sandbox create/get/delete, file upload, worker restart, signed preview URLs. |
| [src/public/index.html](src/public/index.html) | Single-page UI: CodeMirror editor + activity log + toolbar, all in one HTML file. |
| [sandbox/starter.ts](sandbox/starter.ts) | Kicks off the workflow with constants you edit at the top of the file. |
| [sandbox/workflows.ts](sandbox/workflows.ts) | `moneyTransfer` saga definition. |
| [sandbox/activities.ts](sandbox/activities.ts) | `withdraw`, `deposit`, `refund` activities. |
| [sandbox/worker.ts](sandbox/worker.ts) | Worker registering all activities + the workflow. |
| [sandbox/shared.ts](sandbox/shared.ts) | `TASK_QUEUE` constant shared by worker and starter. |
| [sandbox/package.json](sandbox/package.json) | Dependencies baked into the Daytona image. |
