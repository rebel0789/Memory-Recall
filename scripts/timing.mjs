import { spawnSync } from 'node:child_process';

export function timedSpawn(command, args, options = {}) {
  const timeArgs = process.platform === 'darwin' ? ['-l'] : ['-v'];
  return spawnSync('/usr/bin/time', [...timeArgs, command, ...args], options);
}

export function peakRssMb(stderr) {
  const text = String(stderr ?? '');
  const macBytes = Number(text.match(/(\d+)\s+maximum resident set size/u)?.[1] ?? 0);
  if (macBytes) return Number((macBytes / 1024 / 1024).toFixed(1));
  const linuxKb = Number(text.match(/Maximum resident set size \(kbytes\):\s*(\d+)/u)?.[1] ?? 0);
  return Number((linuxKb / 1024).toFixed(1));
}
