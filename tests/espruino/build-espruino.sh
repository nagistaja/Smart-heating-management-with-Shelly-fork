#!/usr/bin/env bash
set -euo pipefail

ESPRUINO_REPO=https://github.com/espruino/Espruino.git
ESPRUINO_COMMIT=e73051ad4b9380a562da40796626254af1a19d57 # 2v29, 2026-10-06 "fix classic ESP32 build"
DOCKER_IMAGE=i386/debian:trixie-slim
CONTAINER=shelly-espruino-build

here=$(cd "$(dirname "$0")" && pwd)
mode=${1:-i386}
workdir=${ESPRUINO_WORKDIR:-$(mktemp -d)}
src=$workdir/espruino

checkout() {
    if [ ! -d "$src/.git" ]; then
        git init -q "$src"
        git -C "$src" remote add origin "$ESPRUINO_REPO"
    fi
    git -C "$src" fetch -q --depth 1 origin "$ESPRUINO_COMMIT"
    git -C "$src" checkout -q -f FETCH_HEAD
    git -C "$src" clean -fdxq
    git -C "$src" apply "$here/espruino-shelly.patch"
}

# Espruino's Makefile calls `python`
python_shim() {
    if ! command -v python >/dev/null; then
        mkdir -p "$workdir/pybin"
        ln -sf "$(command -v python3)" "$workdir/pybin/python"
        export PATH="$workdir/pybin:$PATH"
    fi
}

build_native() {
    python_shim
    make -C "$src" BOARD=LINUX_SHELLY -j"$(nproc)" >"$workdir/build.log" 2>&1 || { tail -20 "$workdir/build.log"; exit 1; }
    cp "$src/bin/espruino" "$here/bin/espruino"
}

# docker cp instead of a bind mount: Docker Desktop shares only some host paths
build_i386() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    # unquoted on purpose: ESPRUINO_DOCKER_OPTIONS may hold several options
    docker run -d --name "$CONTAINER" ${ESPRUINO_DOCKER_OPTIONS:-} "$DOCKER_IMAGE" sleep infinity >/dev/null
    trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT
    docker exec -e DEBIAN_FRONTEND=noninteractive "$CONTAINER" bash -c \
        "apt-get update -qq && apt-get install -y -qq gcc g++ make python3 python-is-python3 git >/dev/null"
    docker exec "$CONTAINER" bash -c "mkdir -p /src && git config --global --add safe.directory /src"
    tar -C "$src" -cf - . | docker cp - "$CONTAINER:/src"
    docker exec "$CONTAINER" bash -c \
        'cd /src && mkdir -p bin && LDFLAGS="-Winline -g -static" make BOARD=LINUX_SHELLY -j"$(nproc)" >/build.log 2>&1 || { tail -20 /build.log; exit 1; }'
    docker cp "$CONTAINER:/src/bin/espruino" "$here/bin/espruino"
}

mkdir -p "$here/bin"
checkout
case "$mode" in
    --native) build_native ;;
    i386) build_i386 ;;
    *) echo "Usage: $0 [--native]" >&2; exit 2 ;;
esac
echo "Built $here/bin/espruino from Espruino $ESPRUINO_COMMIT ($mode)"
