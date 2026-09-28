# serve auth + plugin loading — ground truth (v2.0.9, verified 2026-09-28)

Everything below was established empirically against the running binary, not
from docs. Re-verify if `opencode2 --version` changes.

## Auth (HTTP API)

- `opencode2 serve` prints `server password <PW>` on stdout at startup.
- All HTTP endpoints — including `/openapi.json` — require auth.
- Mechanism: **HTTP Basic**, username `opencode`, password `<PW>`.
  - `curl -u "opencode:$PW" ...` → 200
  - `Authorization: Bearer` → 401; empty-username basic → 401; custom
    headers (`x-opencode-password`, `x-password`, `password`, `x-api-key`) → 401.
  - The `WWW-Authenticate: Basic realm="Secure Area"` response header on 401
    was the decisive clue.
- `@opencode/client` accepts `headers` in `OpenCode.make()` → pass the basic
  header there; the integration harness does exactly this.

## Plugin loading (auto-scan)

- The scanner loads plugin **directories** whose root contains `index.*`:
  - observed loading: `~/.config/opencode/plugins/farsight-v2` (root `index.js`),
    `neolilith-abacus-v2` (root `index.ts`) — `.ts` entrypoints work (bun).
- **NOT loaded** (all verified silent no-ops on v2.0.9, contrary to current docs):
  - project-local `<project>/.opencode/plugins/<dir>` (tried symlink AND real dir)
  - the `plugins: ["<abs path>"]` config array pointing at a package whose
    entry is behind an `exports` map (`.` → `./src/index.ts`)
- Root `index.ts` re-exporting `src/index.ts` makes the scanner load the
  package from a plugins dir. This is the deployment contract we build on.
- Imports resolve from the plugin dir's own `node_modules` (each plugin ships
  its deps — farsight pattern). `@opencode/plugin` must be in plain
  `dependencies` (a `peerDependencies`-only entry does not install with
  `npm install --omit=dev`).

## Isolation for tests

- `XDG_CONFIG_HOME=<dir>` redirects `config` (confirmed via
  `opencode2 debug paths config`) → plugins scan `<dir>/opencode/plugins/`,
  while `data` (and its log dir) stays at `~/.local/share/opencode`.
- A serve booted with an isolated XDG config loads ONLY the staged plugins —
  no interference with the shared background service or Gavin's daily env.

## Still unknown (verify when needed)

- Whether the `plugins` config array works at all on v2.0.9 (docs describe
  it; observed silent skip for our absolute-path entry).
- Whether newer V2 versions restore project-local auto-scan.
