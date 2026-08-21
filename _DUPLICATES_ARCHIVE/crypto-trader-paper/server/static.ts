import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

// CJS-safe __dirname: use __filename global (available in CJS Node), fallback to cwd
const _dirname: string = (() => {
  if (typeof __filename !== "undefined") return path.dirname(__filename);
  // ESM fallback (won't be reached in CJS builds, but keeps TS happy)
  try { return path.dirname(createRequire(process.cwd()).resolve(".")); } catch { return process.cwd(); }
})();

export function serveStatic(app: Express) {
  const serverPublic = path.resolve(_dirname, "public");
  const distPublic = path.resolve(_dirname, "..", "dist", "public");
  const distPath = fs.existsSync(serverPublic) ? serverPublic : distPublic;

  if (!fs.existsSync(distPath)) {
    console.warn(`[STATIC] No build directory found at ${serverPublic} or ${distPublic}. Frontend disabled — API still active.`);
    return;
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
