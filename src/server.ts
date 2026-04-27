/**
 * Express launcher for the Temporal sandbox.
 *
 * Serves a single-page UI and an SSE endpoint that streams progress while a
 * Daytona sandbox is being provisioned.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Request, type Response } from "express";

import { SandboxManager } from "./manager.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const PORT = Number(process.env.PORT ?? 8000);

const manager = new SandboxManager();
const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/api/launch", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (kind: string, payload: unknown) => {
    res.write(`data: ${JSON.stringify({ kind, payload })}\n\n`);
  };

  const log = (msg: string) => send("log", msg);
  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  try {
    const result = await manager.launch(log, (ui) => {
      if (!aborted) send("ui", ui);
    });
    if (!aborted) send("result", result);
  } catch (err) {
    if (!aborted) send("error", (err as Error).message);
  } finally {
    if (!aborted) {
      send("done", null);
      res.end();
    }
  }
});

app.post("/api/stop", async (req: Request, res: Response) => {
  const { sandboxId } = req.body as { sandboxId?: string };
  if (!sandboxId) {
    res.status(400).json({ error: "sandboxId required" });
    return;
  }
  try {
    await manager.stop(sandboxId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/files", async (_req: Request, res: Response) => {
  try {
    res.json(await manager.getEditableFiles());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/run", async (req: Request, res: Response) => {
  const { sandboxId, files } = req.body as {
    sandboxId?: string;
    files?: Record<string, string>;
  };
  if (!files || typeof files !== "object") {
    res.status(400).json({ error: "files required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (kind: string, payload: unknown) => {
    res.write(`data: ${JSON.stringify({ kind, payload })}\n\n`);
  };
  const log = (msg: string) => send("log", msg);

  try {
    const output = await manager.runOrLaunch(sandboxId, files, log, (ui) =>
      send("ui", ui),
    );
    send("result", { workflowResult: output });
  } catch (err) {
    send("error", (err as Error).message);
  } finally {
    send("done", null);
    res.end();
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Temporal sandbox launcher listening on http://127.0.0.1:${PORT}`);
});
