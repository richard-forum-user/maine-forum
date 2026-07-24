import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

function jsFiles() {
  return readdirSync(root).filter((f) => f.endsWith('.js') && f !== 'workerd.capnp');
}

test('no inbound WebSocket server accept in pod worker modules', () => {
  // podlink delivers messages over HTTP (POST /api/inbox), never an inbound
  // WebSocket. This guards the no-inbound-surface sovereignty posture.
  const forbidden = [/new\s+WebSocketPair\s*\(/, /\.accept\s*\(\s*\)/];
  for (const file of jsFiles()) {
    const src = readFileSync(join(root, file), 'utf8');
    for (const pat of forbidden) {
      assert.doesNotMatch(
        src,
        pat,
        `${file} must not create inbound WebSocket listeners (${pat})`
      );
    }
  }
});
