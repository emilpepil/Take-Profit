#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
keeper_user="${SUDO_USER:-$(id -un)}"
template="$project_dir/deploy/take-profit-keeper.service.template"
service_file="/etc/systemd/system/take-profit-keeper.service"

if [[ ! -f "$project_dir/.env" ]]; then
  echo "Missing $project_dir/.env. Create it from .env.example before installing the service." >&2
  exit 1
fi

temp_file="$(mktemp)"
trap 'rm -f "$temp_file"' EXIT
sed \
  -e "s|__KEEPER_USER__|$keeper_user|g" \
  -e "s|__PROJECT_DIR__|$project_dir|g" \
  "$template" > "$temp_file"

sudo install -m 0644 "$temp_file" "$service_file"
sudo systemctl daemon-reload
sudo systemctl enable --now take-profit-keeper.service
sudo systemctl status take-profit-keeper.service --no-pager
