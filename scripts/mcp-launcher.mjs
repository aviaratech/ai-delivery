import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
let cliEntry = join(pluginRoot, 'runtime', 'dist', 'cli.js');
try {
  // Preserve the existing npm runtime only for this exact package-local root.
  // An ambient parent installation can never replace a copied plugin's runtime.
  const packageEntry = fileURLToPath(import.meta.resolve('@aviaratech/ai-delivery'));
  const packageRoot = dirname(dirname(packageEntry));
  if (realpathSync(join(packageRoot, 'plugins', 'ai-delivery')) === pluginRoot)
    cliEntry = join(packageRoot, 'dist', 'cli.js');
} catch {
  // A native cache needs only its own released, bundled runtime.
}
const child = spawn(process.execPath, [realpathSync(cliEntry), 'mcp:serve'], {
  env: process.env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on('error', (error) => {
  process.stderr.write(`Unable to start ai-delivery MCP server: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
