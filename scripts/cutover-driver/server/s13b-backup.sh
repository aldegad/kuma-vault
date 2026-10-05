# Step 13b: first server backup of the new store (C12). Credentials: names and sizes only.
# INSTALL_UNITS=0 (a rehearsal on its own scratch server configuration) never rewrites the
# machine's systemd units: the store is backed up and drilled directly instead of by the unit.
for f in $BACKUP_CRED_FILES; do sudo stat -c '%n %s' "$BACKUP_CRED_DIR/$f"; done
if [ "${BACKUP_INIT_LOCAL:-0}" = 1 ]; then      # rehearsal only: a local repository in the data dir
  sudo test -e "$BACKUP_REPOSITORY/config" || sudo env RESTIC_PASSWORD_FILE="$BACKUP_CRED_DIR/restic-password" \
    restic init --repo "$BACKUP_REPOSITORY" >/dev/null
  sudo chown -R "$SERVE_USER:$SERVE_USER" "$BACKUP_REPOSITORY"
fi
$VS server backup configure --repository "$BACKUP_REPOSITORY" --stores "$STORE" ${BACKUP_HOST:+--host "$BACKUP_HOST"}
if [ "${INSTALL_UNITS:-1}" = 1 ]; then
  $VS server install
  t0=$(date +%s)
  sudo systemctl start kuma-vault-backup.service
else
  t0=$(date +%s)
  $VS server backup run --store "$STORE"
  $VS server backup drill --store "$STORE"
fi
out backupSeconds "$(( $(date +%s) - t0 ))"
$VS server backup status --store "$STORE" | tee "$REP/13b-backup-status.json"
jq -e --arg s "$STORE" '.[$s].lastResult == "ok" and .[$s].lastDrill.result == "ok"' "$REP/13b-backup-status.json" >/dev/null
[ "${INSTALL_UNITS:-1}" = 1 ] && out timer "$(systemctl is-enabled kuma-vault-backup.timer || true)" || true
