/**
 * Daytona sandbox lifecycle for a Temporal dev environment.
 *
 * `launch()` creates a sandbox, installs the Temporal CLI and Node deps,
 * starts the dev server + worker, and runs a hello-world workflow. Returns
 * the public preview URL/token for the Temporal UI plus the sandbox id.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { Daytona, Image, type Sandbox } from "@daytonaio/sdk";

const TEMPORAL_UI_PORT = 8233;
const APP_DIR = "/opt/app";
const TEMPORAL_BIN = "/usr/local/bin/temporal";

// Idle lifecycle: stop the sandbox after 15 min of inactivity, then delete it
// 30 min after stopping. Reclaims orphaned sandboxes when the user walks away.
const AUTO_STOP_MINUTES = 15;
const AUTO_DELETE_MINUTES = 30;

// TTL for signed preview URLs (Temporal UI). The link the user clicks is
// time-limited; pick a window comfortably longer than a typical dev session.
const SIGNED_URL_TTL_SECONDS = 4 * 60 * 60;

const SANDBOX_FILES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "sandbox",
);

// Source files copied into each new sandbox after it's created (workflow code).
// package.json/lock are baked into the image so node_modules is pre-installed.
const SOURCE_FILES = [
  "starter.ts",
  "workflows.ts",
  "activities.ts",
  "worker.ts",
  "shared.ts",
];

// Image is built once by Daytona and cached as a snapshot. Bumping any of the
// inputs below invalidates the snapshot and triggers a rebuild.
const sandboxImage = Image.base("node:20-bookworm-slim")
  .runCommands(
    [
      "apt-get update",
      "apt-get install -y --no-install-recommends curl ca-certificates",
      'arch=$(uname -m | sed "s/x86_64/amd64/;s/aarch64/arm64/")',
      'curl -fsSL "https://temporal.download/cli/archive/latest?platform=linux&arch=$arch" -o /tmp/t.tgz',
      `tar -xzf /tmp/t.tgz -C ${path.dirname(TEMPORAL_BIN)} temporal`,
      `chmod +x ${TEMPORAL_BIN}`,
      "rm /tmp/t.tgz",
      "rm -rf /var/lib/apt/lists/*",
    ].join(" && "),
  )
  .workdir(APP_DIR)
  .addLocalFile(path.join(SANDBOX_FILES_DIR, "package.json"), `${APP_DIR}/package.json`)
  .runCommands(`cd ${APP_DIR} && npm install --silent`);

export type Logger = (msg: string) => void;

export interface UiInfo {
  sandboxId: string;
  uiUrl: string;
  uiToken?: string;
}

export interface LaunchResult extends UiInfo {
  workflowResult: string;
}

export class SandboxManager {
  private readonly daytona: Daytona;

  constructor() {
    const apiKey = process.env.DAYTONA_KEY;
    if (!apiKey) {
      throw new Error("DAYTONA_KEY environment variable is required");
    }
    this.daytona = new Daytona({ apiKey });
  }

  async launch(
    log: Logger,
    onUiReady?: (info: UiInfo) => void,
    files?: Record<string, string>,
  ): Promise<LaunchResult> {
    const { sandbox, uiInfo } = await this.createAndWarm(log, onUiReady, files);
    try {
      const workflowResult = await this.startWorkerAndRunStarter(sandbox, log);
      return { ...uiInfo, workflowResult };
    } catch (err) {
      log(`Launch failed: ${(err as Error).message}. Cleaning up sandbox...`);
      try {
        await sandbox.delete();
      } catch (cleanupErr) {
        log(`Cleanup error (ignored): ${(cleanupErr as Error).message}`);
      }
      throw err;
    }
  }

  /**
   * Provision a sandbox and bring the Temporal dev server up, but stop short
   * of running the workflow. Used to preheat a sandbox at page-load time so
   * the user's first Run is fast.
   */
  async prelaunch(
    log: Logger,
    onUiReady: (info: UiInfo) => void,
  ): Promise<UiInfo> {
    const { uiInfo } = await this.createAndWarm(log, onUiReady);
    return uiInfo;
  }

  /**
   * Create a sandbox, start the Temporal dev server, upload seed source
   * files, and emit the signed preview URL. Returns the live sandbox so the
   * caller can run a workflow on it (or just hold it warm).
   */
  private async createAndWarm(
    log: Logger,
    onUiReady?: (info: UiInfo) => void,
    files?: Record<string, string>,
  ): Promise<{ sandbox: Sandbox; uiInfo: UiInfo }> {
    log("Bootstrapping your sandbox...");
    const sandbox = await this.daytona.create(
      {
        image: sandboxImage,
        language: "typescript",
        autoStopInterval: AUTO_STOP_MINUTES,
        autoDeleteInterval: AUTO_DELETE_MINUTES,
        resources: { disk: 1 },
      },
      {
        onSnapshotCreateLogs: (chunk) => {
          const trimmed = chunk.trim();
          if (trimmed) log(`[image] ${trimmed}`);
        },
      },
    );
    const sandboxId = sandbox.id;

    try {
      // Kick off the dev server immediately and overlap its startup with the
      // file uploads — both are independent and together they're the slowest
      // pre-workflow steps.
      const temporalReady = (async () => {
        await sandbox.process.createSession("temporal-server");
        const startResp = await sandbox.process.executeSessionCommand(
          "temporal-server",
          {
            command: `${TEMPORAL_BIN} server start-dev --ip 0.0.0.0 --ui-ip 0.0.0.0 --log-level warn`,
            runAsync: true,
          },
        );
        await this.waitForTemporal(sandbox, "temporal-server", startResp.cmdId, log);
      })();

      const uploadDone = (async () => {
        for (const filename of SOURCE_FILES) {
          const inMemory = files?.[filename];
          const buf =
            inMemory !== undefined
              ? Buffer.from(inMemory.replace(/\r\n/g, "\n"))
              : await fs.readFile(path.join(SANDBOX_FILES_DIR, filename));
          await sandbox.fs.uploadFile(buf, `${APP_DIR}/${filename}`);
        }
      })();

      await Promise.all([temporalReady, uploadDone]);

      const preview = await sandbox.getSignedPreviewUrl(TEMPORAL_UI_PORT, SIGNED_URL_TTL_SECONDS);
      const uiInfo: UiInfo = {
        sandboxId,
        uiUrl: preview.url,
        uiToken: preview.token,
      };
      log("You're all set. Ready to run?");
      onUiReady?.(uiInfo);

      return { sandbox, uiInfo };
    } catch (err) {
      log(`Sandbox bootstrap failed: ${(err as Error).message}. Cleaning up...`);
      try {
        await sandbox.delete();
      } catch (cleanupErr) {
        log(`Cleanup error (ignored): ${(cleanupErr as Error).message}`);
      }
      throw err;
    }
  }

  async stop(sandboxId: string): Promise<void> {
    const sandbox = await this.daytona.get(sandboxId);
    await sandbox.delete();
  }

  /** Read the current on-disk contents of editable source files. */
  async getEditableFiles(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const filename of SOURCE_FILES) {
      out[filename] = await fs.readFile(
        path.join(SANDBOX_FILES_DIR, filename),
        "utf8",
      );
    }
    return out;
  }

  /**
   * Run the workflow with the given file contents. If `maybeSandboxId` is
   * missing or refers to a sandbox that no longer exists (auto-stopped,
   * deleted, etc.), transparently launches a fresh one. Returns the captured
   * stdout/stderr from the starter run.
   */
  async runOrLaunch(
    maybeSandboxId: string | undefined,
    files: Record<string, string>,
    log: Logger,
    onUiReady: (info: UiInfo) => void,
  ): Promise<string> {
    let sandbox: Sandbox | null = null;
    if (maybeSandboxId) {
      try {
        sandbox = await this.daytona.get(maybeSandboxId);
      } catch {
        log(`Sandbox ${maybeSandboxId} is gone; launching a fresh one...`);
        sandbox = null;
      }
    }

    if (!sandbox) {
      const result = await this.launch(log, onUiReady, files);
      return result.workflowResult;
    }

    const preview = await sandbox.getSignedPreviewUrl(TEMPORAL_UI_PORT, SIGNED_URL_TTL_SECONDS);
    onUiReady({
      sandboxId: sandbox.id,
      uiUrl: preview.url,
      uiToken: preview.token,
    });

    for (const filename of SOURCE_FILES) {
      const incoming = files[filename];
      if (incoming === undefined) continue;
      const normalized = incoming.replace(/\r\n/g, "\n");
      await sandbox.fs.uploadFile(
        Buffer.from(normalized),
        `${APP_DIR}/${filename}`,
      );
    }

    return this.startWorkerAndRunStarter(sandbox, log, { restartWorker: true });
  }

  private async startWorkerAndRunStarter(
    sandbox: Sandbox,
    log: Logger,
    opts: { restartWorker?: boolean } = {},
  ): Promise<string> {
    if (opts.restartWorker) {
      // pkill makes sure the worker process tree is gone before we recreate
      // the session — deleteSession alone isn't documented to kill children.
      await sandbox.process.executeCommand(
        'pkill -f "tsx worker.ts" 2>/dev/null; true',
      );
      try {
        await sandbox.process.deleteSession("worker");
      } catch {
        /* session may not exist yet */
      }
    }

    log("Starting hello-world worker...");
    await sandbox.process.createSession("worker");
    await sandbox.process.executeSessionCommand("worker", {
      command: `cd ${APP_DIR} && npx tsx worker.ts`,
      runAsync: true,
    });
    await sleep(3000);

    log("Triggering workflow via starter.ts...");
    const r = await sandbox.process.executeCommand(
      `cd ${APP_DIR} && npx tsx starter.ts`,
      undefined,
      undefined,
      60,
    );
    if (r.exitCode !== 0) {
      throw new Error(`Workflow run failed: ${r.result}`);
    }
    const out = (r.result ?? "").trim();
    log("Workflow output:");
    for (const line of out.split("\n")) log(`  ${line}`);
    return out;
  }

  private async waitForTemporal(
    sandbox: Sandbox,
    sessionId: string,
    cmdId: string,
    log: Logger,
  ): Promise<void> {
    const timeoutMs = 120_000;
    await sleep(3000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await sandbox.process.executeCommand(
        `${TEMPORAL_BIN} operator cluster health 2>&1`,
        undefined,
        undefined,
        10,
      );
      if (r.exitCode === 0) return;
      await sleep(2000);
    }
    // Surface the dev-server's own logs so the user sees why it didn't start.
    try {
      const logs = await sandbox.process.getSessionCommandLogs(sessionId, cmdId);
      const tail = (logs?.output || logs?.stderr || logs?.stdout || "").trim();
      if (tail) {
        log("temporal-server output:");
        for (const line of tail.split("\n").slice(-20)) log(`  ${line}`);
      } else {
        log("temporal-server produced no output (likely never started)");
      }
    } catch (e) {
      log(`(could not fetch server logs: ${(e as Error).message})`);
    }
    throw new Error(
      `Temporal dev server did not become healthy within ${timeoutMs / 1000}s`,
    );
  }

}
