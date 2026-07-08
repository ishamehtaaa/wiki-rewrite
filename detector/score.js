// Bridge to the Binoculars scoring core in detector/score.py, which runs
// the model pair in PyTorch on MPS (Apple GPU). Setup, one time:
//
//   python3 -m venv detector/venv
//   detector/venv/bin/pip install torch transformers

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const PAIRS = {
  '0.5b': ['Qwen/Qwen2.5-0.5B', 'Qwen/Qwen2.5-0.5B-Instruct'],
  '1.5b': ['Qwen/Qwen2.5-1.5B', 'Qwen/Qwen2.5-1.5B-Instruct'],
};
export const MAX_TOKENS = 512;
export const MIN_TOKENS = 50; // below this, scores are too noisy to trust

const PYTHON = fileURLToPath(new URL('venv/bin/python', import.meta.url));
const SCRIPT = fileURLToPath(new URL('score.py', import.meta.url));

// Score texts in one python invocation (models load once). Returns results
// in input order; entries are null for unscorable texts. onResult(i, r) is
// called as each score arrives, for progress logging on long batches.
export function scoreTexts(size, texts, onResult) {
  if (!existsSync(PYTHON)) {
    console.error('detector venv missing. One-time setup:');
    console.error('  python3 -m venv detector/venv');
    console.error('  detector/venv/bin/pip install torch transformers');
    process.exit(1);
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [SCRIPT], { stdio: ['pipe', 'pipe', 'inherit'] });
    const results = new Array(texts.length).fill(null);
    createInterface({ input: proc.stdout }).on('line', (line) => {
      const { i, error, ...r } = JSON.parse(line);
      results[i] = error ? null : r;
      onResult?.(i, results[i]);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(results);
      else reject(new Error(`score.py exited with code ${code}`));
    });
    proc.stdin.write(JSON.stringify({ size, texts }));
    proc.stdin.end();
  });
}
