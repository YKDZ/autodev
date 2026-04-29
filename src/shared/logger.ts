const writeStdout = (msg: string) => process.stdout.write(msg + "\n");
const writeStderr = (msg: string) => process.stderr.write(msg + "\n");

export const logger = {
  /** Text output to stdout (CLI output) */
  out: writeStdout,
  /** JSON output to stdout (CLI output) */
  json: (data: unknown): void => {
    writeStdout(JSON.stringify(data, null, 2));
  },
  /** Diagnostic info to stderr */
  info: writeStderr,
  /** Diagnostic warning to stderr */
  warn: writeStderr,
  /** Diagnostic error to stderr */
  error: writeStderr,
};
