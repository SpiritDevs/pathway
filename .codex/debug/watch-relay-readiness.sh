#!/bin/sh
# #region DEBUG
debug_log="/Users/coreybaines/GitHub/pathway/.codex/logs/debug.log"
sample=0

while [ "$sample" -lt 60 ]; do
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  for metrics_port in 20241 20242; do
    metrics=$(curl -sS --max-time 1 "http://127.0.0.1:${metrics_port}/metrics" 2>/dev/null)
    connections=$(printf '%s\n' "$metrics" | awk '$1 == "cloudflared_tunnel_ha_connections" { print $2; exit }')
    concurrent=$(printf '%s\n' "$metrics" | awk '$1 == "cloudflared_tunnel_concurrent_requests_per_tunnel" { print $2; exit }')
    requests=$(printf '%s\n' "$metrics" | awk '$1 == "cloudflared_tunnel_total_requests" { print $2; exit }')
    errors=$(printf '%s\n' "$metrics" | awk '$1 == "cloudflared_tunnel_request_errors" { print $2; exit }')
    printf '%s [DEBUG H1,H3,H4 metrics] port=%s ha=%s concurrent=%s requests=%s errors=%s\n' \
      "$timestamp" "$metrics_port" "${connections:-unavailable}" "${concurrent:-unavailable}" \
      "${requests:-unavailable}" "${errors:-unavailable}" >> "$debug_log"
  done

  for origin_port in 3773 3774; do
    status=$(curl -sS --max-time 1 -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:${origin_port}/.well-known/pathway/environment" 2>/dev/null)
    printf '%s [DEBUG H2 origin] port=%s status=%s\n' \
      "$timestamp" "$origin_port" "${status:-unavailable}" >> "$debug_log"
  done

  sample=$((sample + 1))
  sleep 1
done
# #endregion DEBUG
