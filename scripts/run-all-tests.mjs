/**
 * Pulse Metrics — complete TypeScript test discovery.
 *
 * Recursively discovers all supported test files under src/.
 * No shell glob expansion, database changes, or external requests.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const testFiles = [];

function discover(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      discover(fullPath);
      continue;
    }

    if (
      entry.isFile() &&
      /\.test\.(ts|tsx|mts)$/.test(entry.name)
    ) {
      testFiles.push(relative(root, fullPath));
    }
  }
}

discover(join(root, 'src'));
testFiles.sort();

if (testFiles.length === 0) {
  console.error('ERROR: No TypeScript test files discovered.');
  process.exitCode = 1;
} else {
  console.log(`Discovered ${testFiles.length} test files.`);

  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', ...testFiles],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    console.error('ERROR: Could not start the test runner.');
  }

  process.exitCode = result.status ?? 1;
}
