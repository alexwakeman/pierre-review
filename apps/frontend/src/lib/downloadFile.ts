// SAVE A FILE THE PAGE MADE (Reports → Download report). A Blob becomes an object URL, a hidden
// `<a download>` is clicked, and the URL is revoked once the browser has taken it. Nothing leaves the
// machine: the file is made here and saved here.

/** Save `blob` as `filename` through the browser's own download. */
export function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    // A tick later: some browsers start the download asynchronously from the click.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
