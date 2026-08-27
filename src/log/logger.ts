/**
 * Plain-language logger.
 *
 * What: prints sentences a non-engineer can read ("Analyzed 247 repository files.").
 * Use:  `log.info('...')`, `log.warn('...')`, `log.error('...')`. `log.silent()` for tests.
 *       `log.subscribe(fn)` streams every line to a listener (the browser demo uses this).
 * Rule: never log secret values. Callers pass counts and types, not contents, and every
 *       line is passed through `redact()` as a last-chance boundary - a server error that
 *       echoes a rejected cell value must not put sheet data on stdout or in the buffer.
 * Note: browser-safe. Falls back to console when there is no `process.stdout`.
 */
import { redact } from '../scanner/secrets.js';

type Level = 'info' | 'warn' | 'error' | 'debug';

let quiet = false;
let verbose = false;
const buffer: string[] = [];
const listeners = new Set<(level: Level, message: string) => void>();

const hasProcess = typeof process !== 'undefined' && !!process.stdout && typeof process.stdout.write === 'function';

function emit(level: Level, rawMsg: string): void {
  // Last-chance redaction. Upstream layers redact evidence, but API errors can echo a
  // rejected value back to us, so nothing reaches stdout or the buffer unfiltered.
  const msg = redact(rawMsg).text;
  const line = level === 'info' ? msg : `${level.toUpperCase()}: ${msg}`;
  buffer.push(line);
  for (const fn of listeners) { try { fn(level, msg); } catch { /* a listener must never break logging */ } }
  if (quiet) return;
  if (level === 'debug' && !verbose) return;
  if (hasProcess) {
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  } else if (typeof console !== 'undefined') {
    (level === 'error' ? console.error : console.log)(line);
  }
}

export const log = {
  info: (m: string) => emit('info', m),
  warn: (m: string) => emit('warn', m),
  error: (m: string) => emit('error', m),
  debug: (m: string) => emit('debug', m),
  silent: (on = true) => { quiet = on; },
  setVerbose: (on: boolean) => { verbose = on; },
  /** stream every emitted line to a listener; returns an unsubscribe function */
  subscribe: (fn: (level: Level, message: string) => void): (() => void) => { listeners.add(fn); return () => listeners.delete(fn); },
  /** everything emitted so far (used by tests and the report writer) */
  drain: () => buffer.splice(0, buffer.length),
};
