import { spawnSync } from 'node:child_process';

export function timedSpawn(command, args, options = {}) {
  const timeCommand = process.env.OAF_TIME_COMMAND ?? '/usr/bin/time';
  const timeArgs = process.platform === 'darwin' ? ['-l'] : ['-v'];
  const timed = spawnSync(timeCommand, [...timeArgs, command, ...args], options);
  return timed.error?.code === 'ENOENT' ? spawnSync(command, args, options) : timed;
}

export function peakRssMb(stderr) {
  const text = String(stderr ?? '');
  const macBytes = Number(text.match(/(\d+)\s+maximum resident set size/u)?.[1] ?? 0);
  if (macBytes) return Number((macBytes / 1024 / 1024).toFixed(1));
  const linuxKb = Number(text.match(/Maximum resident set size \(kbytes\):\s*(\d+)/u)?.[1] ?? 0);
  return Number((linuxKb / 1024).toFixed(1));
}
