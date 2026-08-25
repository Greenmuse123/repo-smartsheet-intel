/**
 * Plain-language logger.
 *
 * What: prints sentences a non-engineer can read ("Analyzed 247 repository files.").
 * Use:  `log.info('...')`, `log.warn('...')`, `log.error('...')`. `log.silent()` for tests.
 * Rule: never log secret values. Callers pass counts and types, not contents.
 */
type Level = 'info' | 'warn' | 'error' | 'debug';

let quiet = false;
let verbose = false;
const buffer: string[] = [];

function emit(level: Level, msg: string): void {
  const line = level === 'info' ? msg : `${level.toUpperCase()}: ${msg}`;
  buffer.push(line);
  if (quiet) return;
  if (level === 'debug' && !verbose) return;
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  info: (m: string) => emit('info', m),
  warn: (m: string) => emit('warn', m),
  error: (m: string) => emit('error', m),
  debug: (m: string) => emit('debug', m),
  silent: (on = true) => { quiet = on; },
  setVerbose: (on: boolean) => { verbose = on; },
  /** everything emitted so far (used by tests and the report writer) */
  drain: () => buffer.splice(0, buffer.length),
};
