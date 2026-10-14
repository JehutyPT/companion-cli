#!/usr/bin/env node
// Entry point. node:sqlite still prints an ExperimentalWarning on Node 22;
// filter that one warning before loading anything that imports it, so stderr
// carries only the CLI's own one-line reason.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.startsWith("SQLite is an experimental feature")) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { run } = await import("../cli.ts");
process.exitCode = run(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
