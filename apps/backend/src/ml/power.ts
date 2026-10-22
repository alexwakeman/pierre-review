// Is this machine running on battery? Local scoring pauses then (throttle.ts): a backlog drain is
// hours of CPU, which is hours of someone's battery. Read in the background and cached, so the
// enrichment tick can ask SYNCHRONOUSLY (its guards must run before its first await).
//
// macOS: `pmset -g batt` names the source ("'AC Power'" / "'Battery Power'"). Linux: any
// `/sys/class/power_supply/*/online` = 1 on a mains supply. Anything else, or any failure to read,
// is "not known" — and not known never pauses: a desktop with no battery must keep scoring.
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REFRESH_MS = 60_000;
let onBattery: boolean | null = null;
let timer: NodeJS.Timeout | null = null;

/** Parse `pmset -g batt` output. */
export function parsePmset(out: string): boolean | null {
  if (/'Battery Power'/.test(out)) return true;
  if (/'AC Power'/.test(out) || /'UPS Power'/.test(out)) return false;
  return null;
}

function readLinux(): boolean | null {
  const dir = '/sys/class/power_supply';
  let sawMains = false;
  try {
    for (const name of readdirSync(dir)) {
      const type = readFileSync(join(dir, name, 'type'), 'utf8').trim();
      if (type !== 'Mains') continue;
      sawMains = true;
      if (readFileSync(join(dir, name, 'online'), 'utf8').trim() === '1') return false;
    }
  } catch {
    return null;
  }
  return sawMains ? true : null;
}

function refresh(): void {
  if (process.platform === 'darwin') {
    execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 5_000 }, (err, stdout) => {
      onBattery = err ? null : parsePmset(stdout);
    });
  } else if (process.platform === 'linux') {
    onBattery = readLinux();
  }
}

/** True on battery, false on mains, null when it cannot tell. Starts watching on first call. */
export function isOnBattery(): boolean | null {
  if (!timer) {
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
    timer.unref();
  }
  return onBattery;
}
