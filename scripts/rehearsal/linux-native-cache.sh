#!/usr/bin/env bash
set -euo pipefail

# Always create a new bus so this cannot unlock or write an interactive user's keyring.
dbus-run-session -- bash -euo pipefail <<'REHEARSAL'
rehearsal_keyring_root="$(mktemp -d)"
trap 'rm -rf -- "$rehearsal_keyring_root"' EXIT
unset GNOME_KEYRING_CONTROL
export XDG_CONFIG_HOME="$rehearsal_keyring_root/config"
export XDG_DATA_HOME="$rehearsal_keyring_root/data"
export XDG_RUNTIME_DIR="$rehearsal_keyring_root/runtime"
mkdir -m 700 "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"
# A synthetic password for a disposable test keyring, containing no user secrets.
printf 'hype-rehearsal-only' | gnome-keyring-daemon --unlock --components=secrets
xvfb-run -a npm run rehearse:native-cache
REHEARSAL
