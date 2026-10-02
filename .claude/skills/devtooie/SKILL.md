---
# devtooie skill v0.0.0 — managed by `devtooie init`; do not edit
name: devtooie
description: Use when you need to know whether an app, service, or dev server in this repo is currently running or already started — e.g. "is the backend up?", or before launching one yourself — INCLUDING when you don't yet know whether devtooie manages that app, or whether this repo uses devtooie at all (the guide covers how to tell, and how to check an app devtooie does not manage); when running, building, or restarting a local dev package through devtooie; when asked to add, configure, or onboard a package into devtooie; when asked to improve or restructure a Node/TypeScript monorepo for devtooie — e.g. converting packages to TypeScript project references and reshaping their dev/build/clean scripts to be more devtooie-compatible; when you need to know how to handle a package's lifecycle (whether to restart or rebuild it) after changing its code; or when debugging a running package by reading its logs.
---

# devtooie

devtooie is a dependency-aware CLI that runs a monorepo's local dev processes. It can
be driven headlessly, controlled over an HTTP API, taught about new packages, and
queried for logs while a session runs.

> **Stop and restart sessions through the control API — never `kill`, `pkill`, or
> `lsof … | kill` a devtooie process or its port.** To stop a running session,
> `POST /command/quit` (to the API port in `node_modules/.devtooie/running.json`); it shuts
> every package down gracefully and frees the ports — that's all you need before relaunching. To
> restart one package in place without stopping the session, `POST /command/restart/<name>`.
> Reaching for a raw OS kill is a mistake: it kills the process out from under devtooie and
> looks like the session "died" on its own.

If all you need is **whether an app is already running**, read the guide's _"Is the app already
running?"_ section — it covers how to tell whether devtooie manages that app in the first place,
how to read a live session's per-package state, and how to check an app devtooie doesn't manage.
Do it before starting anything: a new session hands off from (and shuts down) a running one.

The consolidated guide ships inside the installed `devtooie` package, so it always matches the
version currently in `node_modules`. It covers driving devtooie headlessly, the control API,
onboarding a package, reading logs, and the full configuration/CLI/API reference.

**Read it now, before acting**, with the Read tool:

```
${CLAUDE_PROJECT_DIR}/node_modules/devtooie/docs/agents.md
```

That should already read as an absolute path. If it still shows an unresolved placeholder, your
harness does not substitute them — read `node_modules/devtooie/docs/agents.md` resolved from the
repository root instead, NOT from this skill's own directory, which has no `node_modules` under it.

Nothing loads the guide for you. That path is deliberately not an `@` reference: `@` force-loads
the whole file, which defeats the progressive disclosure a skill exists to provide. If you have not
run Read, you have not seen it.
