# Undo of 13b: drop the backup block, install turns the timer off. Snapshots stay (harmless).
$VS server backup unconfigure || true
$VS server install
out timer "$(systemctl is-enabled kuma-vault-backup.timer || true)"
