// STORY CHAT — the chat's temp folder: where the PR diffs are written at prepare time (the clone cache
// is blobless, so the agent reads each PR's change from GitHub's own diff). Named per install so one
// install's boot sweep never deletes another's. Pure.

/** The temp base: `/tmp` on macOS and Linux (short, predictable), else the system's. */
export function chatTmpBase(platform: NodeJS.Platform, systemTmp: string, hasSlashTmp: boolean): string {
  return (platform === 'linux' || platform === 'darwin') && hasSlashTmp ? '/tmp' : systemTmp;
}

/** Prefix of every chat temp folder of THIS install (a short hash of the data folder). */
export function chatTmpPrefix(dataDir: string): string {
  let h = 0;
  for (const ch of dataDir) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `limn-q-${(h >>> 0).toString(36).slice(0, 5)}-`;
}
