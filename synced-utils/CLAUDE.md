# synced-utils/ — mirrored shared code

Every directory here is a package mirrored from the `synced-utils` repo
(`packages/<name>/package/` there) by its daemon. The mirror is **two-way and live**: an edit
made here reaches the shared repo and every other consumer within a second, and vice versa.
There is no conflict detection — the side that changed last wins.

Working rules:

- Edit freely, here or in the shared repo; both are the source of truth.
- Treat every file here as shared with other projects. Nothing project-specific belongs in it.
- `node_modules/` inside each package is **this repo's own** — linked by this repo's
  `pnpm install` from its single root `pnpm-lock.yaml`, never mirrored. There is no lockfile
  inside a package.
- This repo must keep **one shared lockfile** (never `sharedWorkspaceLockfile: false`). A package
  declares a framework it shares with the app (`@nestjs/*`, `react`) as a `peerDependency` only;
  under the shared lockfile that links it to the app's own copy. Two copies break `instanceof`
  across the boundary (an `HttpException` from a package becomes a 500).
- A `git checkout` that changes files here counts as an edit and is mirrored out. Undo with git
  on each side.
- This `CLAUDE.md` is itself mirrored (from `packages/CLAUDE.md` in the shared repo), as are the
  files a package contributes to this repo's `.claude/` (from `packages/<name>/.claude/`). Files in
  `.claude/` that no package owns are never touched.
- `.synced-utils.json` here records this repo's path so the daemon can follow it if the repo moves.
- To add a package, or wire it into another workspace package:
  `synced-utils add <package> -t <workspace-package-name-or-dir>`.
