#!/bin/sh
# Menapoly Cue private pilot: provisioning and deployment for cue.menapoly-digital.com.
#
# By default this PRINTS the commands for a phase and changes nothing. Running a phase for real needs --execute and a
# typed confirmation that matches the approval in docs/cloud/pilot/APPROVAL-CHECKLIST.md.
#
#   cloud/control-plane/pilot/provision.sh resources            # print
#   cloud/control-plane/pilot/provision.sh resources --execute  # create D1, R2 (private), queues; apply migrations
#   cloud/control-plane/pilot/provision.sh deploy --execute     # deploy the Worker WITH its secrets in one step
#
# Run from the repository root, signed in with `npx wrangler login` to the account that owns menapoly-digital.com.
set -eu
PHASE=${1:-help}
MODE=${2:-print}
HERE=$(cd "$(dirname "$0")" && pwd)
CP=$(cd "$HERE/.." && pwd)
ROOT=$(cd "$CP/../.." && pwd)
PY="$ROOT/backend/.venv/bin/python"
W="npx wrangler"

run() {
  echo "+ $*"
  if [ "$MODE" = "--execute" ]; then (cd "$CP" && "$@"); fi
}

confirm() {
  [ "$MODE" = "--execute" ] || return 0
  echo
  echo "This changes your Cloudflare account ($1)."
  printf 'Type exactly: %s\n> ' "$2"
  read -r answer
  [ "$answer" = "$2" ] || { echo "Not confirmed. Nothing was changed."; exit 1; }
}

case "$PHASE" in
resources)
  confirm "creates D1, a private R2 bucket and two queues" "I approve creating the pilot resources"
  run $W d1 create menapoly-cue-cloud
  run $W r2 bucket create menapoly-cue-media
  run $W r2 bucket dev-url disable menapoly-cue-media --force
  run $W r2 bucket cors set menapoly-cue-media --file pilot/r2-cors.json --force
  run $W r2 bucket lifecycle add menapoly-cue-media abort-incomplete-uploads --abort-multipart-days 2 --force
  run $W queues create menapoly-cue-events --message-retention-period-secs 86400
  run $W queues create menapoly-cue-events-dlq --message-retention-period-secs 86400
  echo
  echo "NEXT (manual): put the database_id printed by 'd1 create' into wrangler.jsonc under d1_databases[0],"
  echo "then apply the schema:"
  echo "  (cd cloud/control-plane && npx wrangler d1 migrations apply DB --remote)"
  echo "Then create the R2 API token (Object Read & Write, this bucket only) in the dashboard."
  ;;
deploy)
  confirm "deploys the Worker to cue.menapoly-digital.com" "I approve deploying the Menapoly Cue pilot"
  if [ "$MODE" = "--execute" ]; then
    # Read-only checks first: security gate, domain, Access apps, resources. Any PROBLEM stops the deploy.
    "$PY" "$HERE/preflight.py" --stage before-deploy || { echo "Preflight found a problem. Not deploying."; exit 1; }
    (cd "$CP" && npx tsc --noEmit && npm test >/dev/null && echo "typecheck + tests OK")
    SECRETS=$(mktemp)
    chmod 600 "$SECRETS"
    trap 'rm -f "$SECRETS"' EXIT INT TERM
    echo "Enter the Worker secrets (input hidden; nothing is stored after the deploy):"
    for KEY in CF_ACCESS_AUD CF_ACCESS_TEAM_DOMAIN OWNER_EMAILS S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
      printf '  %s: ' "$KEY"
      stty -echo 2>/dev/null || true
      read -r VALUE
      stty echo 2>/dev/null || true
      echo
      [ -n "$VALUE" ] || { echo "$KEY is required. Not deploying."; exit 1; }
      printf '%s=%s\n' "$KEY" "$VALUE" >> "$SECRETS"
    done
    # One step: the very first version already has the Access settings, so it never runs without sign-in.
    (cd "$CP" && npx wrangler deploy --secrets-file "$SECRETS")
    rm -f "$SECRETS"
    echo
    "$PY" "$HERE/preflight.py" --stage after-deploy || { echo "AFTER-DEPLOY CHECK FAILED: follow docs/cloud/rollback.md now."; exit 1; }
  else
    echo "+ backend/.venv/bin/python cloud/control-plane/pilot/preflight.py --stage before-deploy"
    echo "+ (prompted, hidden) CF_ACCESS_AUD CF_ACCESS_TEAM_DOMAIN OWNER_EMAILS S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY"
    echo "+ npx wrangler deploy --secrets-file <temporary file, mode 600, deleted afterwards>"
    echo "+ backend/.venv/bin/python cloud/control-plane/pilot/preflight.py --stage after-deploy"
  fi
  ;;
*)
  echo "usage: $0 resources|deploy [--execute]"
  echo "Without --execute the commands are only printed."
  ;;
esac
