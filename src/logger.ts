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

function emit(level: Level, scope: string, msg: string): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 23);
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
