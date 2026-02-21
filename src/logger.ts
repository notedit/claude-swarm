/**
 * Structured logger for claude-swarm.
 *
 * Emits newline-delimited JSON (NDJSON) to stdout so logs can be ingested by
 * Cloudflare Logpush, Datadog, or any log aggregator that understands JSON.
 *
 * Every log line includes:
 *   - ts        ISO-8601 timestamp
 *   - level     debug | info | warn | error
 *   - component The subsystem emitting the log (worker / orchestrator / agent)
 *   - traceId   Request-scoped identifier for correlating a full request trace
 *   - sessionId Agent session identifier (when available)
 *   - msg       Human-readable message
 *   - ...extra  Any additional key-value pairs passed by the caller
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  component: string;
  traceId?: string;
  sessionId?: string;
}

export interface LogEntry extends LogContext {
  ts: string;
  level: LogLevel;
  msg: string;
  durationMs?: number;
  [key: string]: unknown;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[MIN_LEVEL];
}

function emit(entry: LogEntry): void {
  if (!shouldLog(entry.level)) return;
  // Use console.log so Cloudflare Workers / Node both capture it
  console.log(JSON.stringify(entry));
}

export class Logger {
  private ctx: LogContext;

  constructor(ctx: LogContext) {
    this.ctx = ctx;
  }

  /** Return a child logger with additional context merged in */
  child(extra: Partial<LogContext>): Logger {
    return new Logger({ ...this.ctx, ...extra });
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.write("debug", msg, extra);
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    this.write("info", msg, extra);
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    this.write("warn", msg, extra);
  }

  error(msg: string, extra?: Record<string, unknown>): void {
    this.write("error", msg, extra);
  }

  /**
   * Wrap an async operation in a timed span.
   * Logs start + end (with durationMs) at "info" level, error at "error".
   */
  async span<T>(
    name: string,
    fn: () => Promise<T>,
    extra?: Record<string, unknown>,
  ): Promise<T> {
    const start = Date.now();
    this.info(`${name} start`, extra);
    try {
      const result = await fn();
      this.info(`${name} done`, {
        ...extra,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      this.error(`${name} failed`, {
        ...extra,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private write(
    level: LogLevel,
    msg: string,
    extra?: Record<string, unknown>,
  ): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      ...this.ctx,
      msg,
      ...extra,
    };
    emit(entry);
  }
}

/** Generate a short random trace ID (8 hex chars) */
export function newTraceId(): string {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Root logger factories for each component */
export const rootLogger = {
  worker: (traceId: string, sessionId?: string) =>
    new Logger({ component: "worker", traceId, sessionId }),

  orchestrator: (traceId: string, sessionId?: string) =>
    new Logger({ component: "orchestrator", traceId, sessionId }),

  agent: (sessionId?: string) =>
    new Logger({ component: "agent", sessionId }),
};
