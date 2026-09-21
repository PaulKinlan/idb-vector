#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
clang --target=wasm32 -O3 -msimd128 -ffp-contract=off -nostdlib \
  -Wl,--no-entry -Wl,--export=score -Wl,--export=__heap_base -Wl,--export-memory \
  demo/compute/cosine.c -o demo/compute/cosine.wasm
