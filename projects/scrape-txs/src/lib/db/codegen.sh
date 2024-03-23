#!/bin/bash
set -e
__dirname=$(dirname $(readlink -f ${BASH_SOURCE[0]}))
cd $__dirname

bun kysely-codegen \
  --include-pattern="public.*" \
  --out-file ./codegen.d.ts
