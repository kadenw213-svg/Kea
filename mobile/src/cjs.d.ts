// Kea on the PC's CommonJS modules, bundled into the phone app as they are (vite.config.mjs).
declare module '*.cjs' {
  const m: any;
  export default m;
}
