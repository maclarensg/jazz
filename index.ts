// Root entrypoint: v2.0.9's plugin-dir auto-scan loads index.* at the plugin
// root (observed: farsight-v2 index.js, neolilith-abacus-v2 index.ts). The
// package exports map serves the array-loading path; this file serves the scan.
export { default } from "./src/index"
