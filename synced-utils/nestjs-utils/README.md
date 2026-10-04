# @rhyek/nestjs-utils

NestJS utilities, consumed as TypeScript source.

| | |
|---|---|
| [structured-logger](./src/structured-logger/README.md) | Structured JSON logging on pino: per-request context, mixins, an axios-aware error serializer, credential redaction. |

## Install

```bash
synced-utils add nestjs-utils -t <workspace-package>
```

The app supplies the peers itself: `@nestjs/common`, `@nestjs/core`, `pino`, `rxjs`.

## What the consuming app must provide

There is no build: the app's own toolchain compiles this source, so it has to handle Nest's
decorators.

- **`experimentalDecorators` and `emitDecoratorMetadata`** in the app's tsconfig.
- **A runtime that honours them** — `node --import @swc-node/register/esm-register`. Node's own
  type stripping does neither.
- **A shared pnpm lockfile, and one Nest version in the workspace.** Nest is a `peerDependency`
  here and nothing else, so with one root lockfile pnpm links this package to the app's own copy
  of `@nestjs/common`. With `sharedWorkspaceLockfile: false` — or two apps on different Nest
  versions — it loads a second copy: the `HttpException` from `createError` then fails the app's
  `instanceof` check and the client gets a 500 instead of the status given. Nest's DI still works,
  which makes it easy to miss. Check that these print the same path:
  ```bash
  realpath <app>/node_modules/@nestjs/common
  realpath synced-utils/nestjs-utils/node_modules/@nestjs/common
  ```
- **TypeScript 6.** `@swc-node/register` loads the classic compiler API, which TypeScript 7 no
  longer ships ([swc-project/swc-node#1049](https://github.com/swc-project/swc-node/issues/1049)).

## Examples

`example/<utility>/` is a runnable app exercising that utility's whole public surface, and the app
its spec boots:

```bash
node --import @swc-node/register/esm-register example/structured-logger/main.ts
```
