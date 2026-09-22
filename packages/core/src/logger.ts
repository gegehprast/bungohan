/** How much the server logs; `"silent"` turns logging off. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

/** `ServerOptions.logger`. */
export interface LoggerOptions {
  /** Least severe level printed. Default `"info"`. */
  level?: LogLevel
  /** Where lines go. Default `console`. */
  sink?: Pick<Console, "debug" | "info" | "warn" | "error">
}

const RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
}

/** Minimal leveled logger; every line is prefixed `[bungohan]`. */
export class Logger {
  private readonly _rank: number
  private readonly _sink: Pick<Console, "debug" | "info" | "warn" | "error">

  public constructor(options: LoggerOptions = {}) {
    this._rank = RANK[options.level ?? "info"]
    this._sink = options.sink ?? console
  }

  /** Detail for debugging: dropped frames, failed sends. */
  public debug(message: string, ...extra: unknown[]): void {
    if (this._rank <= RANK.debug)
      this._sink.debug(`[bungohan] ${message}`, ...extra)
  }

  /** Normal events worth a line, such as a shutdown signal. */
  public info(message: string, ...extra: unknown[]): void {
    if (this._rank <= RANK.info)
      this._sink.info(`[bungohan] ${message}`, ...extra)
  }

  /** Something unexpected the server recovered from. */
  public warn(message: string, ...extra: unknown[]): void {
    if (this._rank <= RANK.warn)
      this._sink.warn(`[bungohan] ${message}`, ...extra)
  }

  /** A failure: a hook that threw, a room that couldn't be created. */
  public error(message: string, ...extra: unknown[]): void {
    if (this._rank <= RANK.error)
      this._sink.error(`[bungohan] ${message}`, ...extra)
  }
}
