// Client for classify.py --serve (one JSON line per request/response) and
// calibration-based verdict phrasing. Shared by detect.js and sweep.js.

import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const PYTHON = fileURLToPath(new URL('venv/bin/python', import.meta.url));
const SCRIPT = fileURLToPath(new URL('classify.py', import.meta.url));

// Long-lived scorer: the model loads once, then score() as many times as
// needed. Call close() when done or the process lingers.
export function startScorer(model) {
  if (!existsSync(PYTHON)) {
    console.error('detector venv missing. One-time setup:');
    console.error('  python3 -m venv detector/venv');
    console.error('  detector/venv/bin/pip install torch transformers sentencepiece protobuf');
    process.exit(1);
  }
  const proc = spawn(PYTHON, [SCRIPT, '--serve', `--model=${model}`], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 0;
  createInterface({ input: proc.stdout }).on('line', (line) => {
    const { id, p } = JSON.parse(line);
    pending.get(id)?.resolve(p);
    pending.delete(id);
  });
  proc.on('close', (code) => {
    for (const { reject } of pending.values()) reject(new Error(`classify.py exited (code ${code})`));
    pending.clear();
  });
  return {
    score(text) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        proc.stdin.write(JSON.stringify({ id, text }) + '\n');
      });
    },
    close() {
      proc.stdin.end();
    },
  };
}

export function loadCalibration(model) {
  try {
    return JSON.parse(readFileSync(new URL('thresholds.json', import.meta.url), 'utf8'))[model] ?? null;
  } catch {
    return null;
  }
}

// The strictest benchmark operating point this score clears gives the
// measured trade-off at this level — honest phrasing, not invented labels.
export function verdictFor(p, calibration) {
  if (!calibration) return { verdict: p >= 0.5 ? 'AI-leaning (uncalibrated)' : 'human-leaning (uncalibrated)' };
  const cleared = [...calibration.operatingPoints].reverse().find((o) => p >= o.t);
  if (!cleared) return { verdict: 'human-typical' };
  const verdict = cleared.fpr <= 0.05 ? 'AI-typical' : 'leaning AI — inspect manually';
  return { verdict, atThisLevel: { caughtAI: cleared.tpr, falseFlaggedHuman: cleared.fpr } };
}
