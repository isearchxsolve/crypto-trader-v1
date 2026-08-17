import dotenv from "dotenv";
// SAFETY (2026-08-16): explicit operator intent must win over .env. If WALLET_PRIVATE_KEY
// is present in the shell environment — even set to EMPTY to mean "disarm live trading" —
// dotenv's override:true must NOT silently re-arm it from .env. That override is exactly how
// a paper-mode run quietly became a live-armed run (the root cause of the "I cannot trust it"
// report). Capture the explicit shell state BEFORE dotenv runs, then restore it after, so an
// explicit disarm (or an explicit key) can never be clobbered by the .env file.
const _walletKeyExplicitlySet = Object.prototype.hasOwnProperty.call(process.env, "WALLET_PRIVATE_KEY");
const _walletKeyExplicitValue = process.env.WALLET_PRIVATE_KEY;
dotenv.config({ override: false });
if (_walletKeyExplicitlySet) {
  process.env.WALLET_PRIVATE_KEY = _walletKeyExplicitValue;
  if (!(_walletKeyExplicitValue || "").trim()) {
    console.log("[SAFETY] WALLET_PRIVATE_KEY explicitly emptied in environment — live trading stays DISABLED (.env value ignored).");
  }
}
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { installConsoleRedaction, log } from "./logger";
import { assertStartupEnvironment, redactLogMeta, redactText } from "./production-safety";
import { storage } from "./storage";

installConsoleRedaction();
const startupConfig = assertStartupEnvironment(process.env);

const app = express();
const httpServer = createServer(app);

process.on("exit", (code) => {
  console.log(`[DEBUG] Process is exiting with code: ${code}`);
});

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function logHttp(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  log.info(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(redactLogMeta(capturedJsonResponse))}`;
      }

      logHttp(logLine);
    }
  });

  next();
});

// Handle unhandled errors - log but don't exit on non-critical errors
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled Rejection", { error: redactText(reason) });
  // Don't exit - many rejections are transient network issues
});

process.on("uncaughtException", (err) => {
  // Use try-catch: if the logger itself is broken (e.g., dead multistream),
  // calling log.error would throw another uncaughtException → infinite loop → crash.
  try {
    log.error("Uncaught Exception", { error: redactText(err.message), stack: redactText(err.stack) });
  } catch {
    console.error("[FALLBACK] Uncaught Exception (logger broken):", redactText(err.message));
  }
  // Only exit on truly fatal errors (e.g., out of memory, critical config missing)
  const fatalMessages = ["ENOMEM", "EACCES", "config", "DATABASE_URL", "WALLET_PRIVATE_KEY"];
  const isFatal = fatalMessages.some(msg => 
    err.message?.includes?.(msg) || err.stack?.includes?.(msg)
  );
  if (isFatal) {
    console.error("Fatal error detected, exiting...", redactText(err.message));
    log.error("Fatal error detected, exiting...");
    setTimeout(() => process.exit(1), 500);
  }
  log.warn("Non-fatal uncaught exception, continuing...");
});

(async () => {
  try {
    await registerRoutes(httpServer, app);

    app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = "Internal Server Error";

      log.error("Internal Server Error", { error: redactText(err.message), stack: redactText(err.stack) });

      if (res.headersSent) {
        return next(err);
      }

      return res.status(status).json({ message });
    });

    // importantly only setup vite in development and after
    // setting up all the other routes so the catch-all route
    // doesn't interfere with the other routes
    if (process.env.NODE_ENV === "production" || process.env.SKIP_VITE === "true") {
      serveStatic(app);
    } else {
      log.info("[VITE] Compiling React frontend... this usually takes 10-15 seconds. Please do not close the server!");
      const { setupVite } = await import("./vite");
      await setupVite(httpServer, app);
    }

    // ALWAYS serve the app on the port specified in the environment variable PORT
    // Other ports are firewalled. Default to 5000 if not specified.
    // this serves both the API and the client.
    // It is the only port that is not firewalled.
    const port = startupConfig.port;
    
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[FATAL] Port ${port} already in use. Kill the existing process and try again.`);
        log.error(`Port ${port} already in use`, { error: redactText(err.message) });
      } else {
        console.error(`[FATAL] HTTP Server Error: ${redactText(err.message)}`);
        log.error("HTTP Server Error", { error: redactText(err.message), code: err.code });
      }
      setTimeout(() => process.exit(1), 500);
    });

    // reusePort removed: a single trading engine must own port 5000 exclusively.
    // Without it, a second launch hits the EADDRINUSE guard above and exits loudly
    // instead of silently double-running (which would mean double trades).
    httpServer.listen(
      {
        port,
        host: "0.0.0.0",
      },
      () => {
        logHttp(`serving on port ${port}`);
      },
    );

    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.warn("Graceful shutdown requested", { signal });
      Promise.resolve(storage.getOpenTrades())
        .then(openTrades => storage.updateBotStats({ openPositions: openTrades.length, lastSignal: `shutdown:${signal}` }))
        .catch(error => log.error("Unable to checkpoint open positions during shutdown", { error: redactText(error) }))
        .finally(() => httpServer.close(() => process.exit(0)));
      setTimeout(() => process.exit(1), 15_000).unref();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  } catch (err) {
    console.error("[FATAL] Startup failed:", redactText(err));
    log.error("Startup failed", { error: redactText(err) });
    setTimeout(() => process.exit(1), 500);
  }
})();
