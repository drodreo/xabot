/**
 * Structured error type for xabot operations.
 */
export class XabotError extends Error {
  constructor(msg: string, public readonly code: string = 'UNKNOWN') {
    super(msg);
    this.name = 'XabotError';
  }

  static platform(msg: string): XabotError {
    return new XabotError(msg, 'PLATFORM');
  }

  static auth(msg: string): XabotError {
    return new XabotError(msg, 'AUTH');
  }

  static acp(msg: string): XabotError {
    return new XabotError(msg, 'ACP');
  }

  static config(msg: string): XabotError {
    return new XabotError(msg, 'CONFIG');
  }
}
