export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

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

  public debug(message: string, ...extra: unknown[]): void {
    if (this._rank <= RANK.debug)
      this._sink.debug(`[bungohan] ${message}`, ...extra)
  }

  public info(message: string, ...extra: unknown[]): void {
    if (this._rank <= RANK.info)
      this._sink.info(`[bungohan] ${message}`, ...extra)
  }

  public warn(message: string, ...extra: unknown[]): void {
    if (this._rank <= RANK.warn)
      this._sink.warn(`[bungohan] ${message}`, ...extra)
  }

  public error(message: string, ...extra: unknown[]): void {
    if (this._rank <= RANK.error)
      this._sink.error(`[bungohan] ${message}`, ...extra)
  }
}
