import pino from 'pino';
import pretty from 'pino-pretty';
import fs from 'fs';
import path from 'path';

const logDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const isProd = true; // process.env.NODE_ENV === 'production';
const logFile = path.join(logDir, 'app.log');

// Rotate on startup if log exceeds 50MB (just rename, no rm)
try {
  const stat = fs.statSync(logFile);
  if (stat.size > 50 * 1024 * 1024) {
    const rotated = `${logFile}.1`;
    if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
    fs.renameSync(logFile, rotated);
    console.log(`[LOGGER] Rotated app.log (${(stat.size / 1024 / 1024).toFixed(1)}MB) → app.log.1`);
  }
} catch {}

// File destination — pino.destination uses SonicBoom (in-process, NO worker thread).
const fileStream = pino.destination({ dest: logFile, sync: !isProd });

let logger: pino.Logger;

if (isProd) {
  // Production: file-only to avoid EPIPE when process is backgrounded
  logger = pino({ level: process.env.LOG_LEVEL || 'info' }, fileStream);
} else {
  // Development: JSON to file + pretty to console.
  // IMPORTANT: use the in-process pretty() stream (NOT pino.transport), which
  // spawns a worker thread. A dead worker throws "the worker has exited" on every
  // log call, and the uncaughtException handler re-logs → infinite exception loop
  // → event-loop saturation → HTTP hangs forever with the process never exiting.
  // The in-process stream cannot die this way.
  const prettyStream = pretty({
    colorize: true,
    translateTime: 'HH:MM:ss',
    ignore: 'pid,hostname',
  });
  logger = pino({ level: process.env.LOG_LEVEL || 'info' }, pino.multistream([
    { stream: fileStream },
    { stream: prettyStream },
  ]));
}

export const log = {
  info: (msg: string, meta?: object) => logger.info(meta, msg),
  warn: (msg: string, meta?: object) => logger.warn(meta, msg),
  error: (msg: string, meta?: object) => logger.error(meta, msg),
  debug: (msg: string, meta?: object) => logger.debug(meta, msg),
};
