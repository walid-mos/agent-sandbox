// The body runs only when its module is the process entry point, so importing a module to inspect it changes nothing.
export async function main({ main: isEntryPoint }, body) {
  if (!isEntryPoint) return;
  try {
    await body();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export function runOperation(operations, usage) {
  const [operation, ...arguments_] = process.argv.slice(2);
  if (!Object.hasOwn(operations, operation)) throw new Error(usage);
  return operations[operation](arguments_);
}
