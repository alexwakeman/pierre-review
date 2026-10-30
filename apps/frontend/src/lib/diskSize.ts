// A byte count as a reader says it: "0 MB", "12 MB", "1.4 GB". Megabytes are whole; gigabytes carry
// one decimal (dropped when it is .0). Settings → AI → Disk space is the one reader.
export function diskSizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb).toLocaleString('en-US')} MB`;
  const gb = Math.round((mb / 1024) * 10) / 10;
  return `${gb.toLocaleString('en-US', { maximumFractionDigits: 1 })} GB`;
}
