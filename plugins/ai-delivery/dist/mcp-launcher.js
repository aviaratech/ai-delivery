import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageEntry = import.meta.resolve('@aviaratech/ai-delivery');
if (!packageEntry.startsWith('file:')) {
  throw new Error('Cannot resolve the installed @aviaratech/ai-delivery package to a file');
}

const cliEntry = fileURLToPath(new URL('./cli.js', packageEntry));
const child = spawn(process.execPath, [cliEntry, 'mcp:serve'], {
  env: process.env,
  stdio: 'inherit',
});

child.on('error', (error) => {
  process.stderr.write(`Unable to start ai-delivery MCP server: ${error.message}\n`);
  process.exitCode = 1;
});

child.on('close', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
