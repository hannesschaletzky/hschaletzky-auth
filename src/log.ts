/**
 * Minimal structured logger (JSON lines on stdout/stderr).
 *
 * Rule: never pass personal data or posting content in `fields` — no names, e-mails,
 * posting texts or cover letters. Log ids, counts and durations instead.
 */
type Fields = Record<string, string | number | boolean | null>;

function write(level: 'info' | 'warn' | 'error', msg: string, fields: Fields = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === 'info') process.stdout.write(line + '\n');
  else process.stderr.write(line + '\n');
}

export const log = {
  info: (msg: string, fields?: Fields) => {
    write('info', msg, fields);
  },
  warn: (msg: string, fields?: Fields) => {
    write('warn', msg, fields);
  },
  error: (msg: string, fields?: Fields) => {
    write('error', msg, fields);
  },
};
