type Level = 'debug' | 'info' | 'warn' | 'error';

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = LEVEL_ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'];

/** One structured log line, broadcast to UI subscribers via the log bus. */
export interface LogEntry {
  ts: string;
  level: Level;
  scope: string;
  msg: string;
}

type LogSubscriber = (entry: LogEntry) => void;

// Log bus: every emit() fans out to these subscribers (the SSE endpoint) on top
// of printing to the console, so the UI can show a live feed without touching
// any individual call site.
const subscribers = new Set<LogSubscriber>();

// Ring buffer of the most recent lines so a client that connects mid-run gets
// recent history instead of an empty panel.
const RING_SIZE = 500;
const ring: LogEntry[] = [];

/** Subscribe to the live log stream. Returns an unsubscribe function. */
export function subscribeLogs(fn: LogSubscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Snapshot of the most recent log lines (oldest first). */
export function recentLogs(): LogEntry[] {
  return ring.slice();
}

function emit(level: Level, scope: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  // The ring buffer + bus capture every level regardless of the console
  // threshold, so the UI panel can show debug lines the terminal suppresses.
  const entry: LogEntry = { ts, level, scope, msg };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      // A broken subscriber must never break logging.
    }
  }

  if (LEVEL_ORDER[level] < threshold) return;
  const line = `${COLORS[level]}${ts} ${level.toUpperCase().padEnd(5)}${RESET} [${scope}] ${msg}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Returns a scoped logger that prefixes every line with `[scope]`. */
export function createLogger(scope: string): Logger {
  return {
    debug: (m) => emit('debug', scope, m),
    info: (m) => emit('info', scope, m),
    warn: (m) => emit('warn', scope, m),
    error: (m) => emit('error', scope, m),
  };
}
