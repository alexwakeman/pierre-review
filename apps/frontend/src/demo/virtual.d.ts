// Resolved by the demo build (vite.config.ts, mode `demo`) to `data/recording.json` when that
// file exists, else to `data/sample-recording.json`.
declare module 'virtual:limn-demo-recording' {
  const recording: unknown;
  export default recording;
}
