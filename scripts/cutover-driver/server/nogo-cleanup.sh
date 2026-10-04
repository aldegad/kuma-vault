# A no-go before anything changed: delete the work directory this attempt created (marker).
if [ -d "$T" ] && [ "$(cat "$T/.attempt" 2>/dev/null || true)" = "$C8_ATTEMPT" ]; then
  release_mounts
  rm -rf "${T:?}"
fi
out workDirExists "$([ -e "$T" ] && echo true || echo false)"
