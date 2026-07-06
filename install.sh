#!/usr/bin/env bash
set -euo pipefail

rho_dir="${RHO_DIR:-$HOME/.pi}"

git clone https://github.com/Dodge100/rho.git "$rho_dir"

if [ -f "$HOME/.pi/agent/settings.json" ]; then
  cp "$HOME/.pi/agent/settings.json" "$rho_dir/settings.json.prev"
fi

mkdir -p "$HOME/.pi/agent/extensions"
cp -r "$rho_dir/agent/extensions/"* "$HOME/.pi/agent/extensions/"
cp "$rho_dir/agent/settings.json" "$HOME/.pi/agent/settings.json"

pi install npm:pi-web-access
pi install npm:pi-ultra-compact
pi install npm:pi-loadout
pi install npm:@quintinshaw/pi-dynamic-workflows
pi install npm:pi-wakatime
