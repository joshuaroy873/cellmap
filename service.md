# Deployment

Repository on `ghoshlab2`: `/home/jpalathi/Documents/Repos/_research/cellmap`.

## Services

| Purpose | Unit | Listener | URL |
| --- | --- | --- | --- |
| Public website | system `cellmap.service` | `127.0.0.1:8000` behind a Cloudflare tunnel | https://cellmap.joshuaroy873.com |
| Tailnet testing | user `cellmap-local.service` | Tailscale IPv4 (`tailscale ip -4`) port 8001 | http://ghoshlab2.taila7dab6.ts.net:8001/ |

Unit files live outside Git:

- `/etc/systemd/system/cellmap.service`
- `/home/jpalathi/.config/systemd/user/cellmap-local.service` (user lingering
  is enabled so it starts without a login)

Both units run `.venv/bin/python website/server.py` from this one checkout and
share its dataset, share-link store and CARTO key. **The preview is not an
isolated copy.** Whatever is on disk is what both sites serve: static files on
the next page load, Python after a restart. Checking out a branch changes the
public site too. A private preview needs a second checkout (`git worktree`)
with its own unit.

Use the full tailnet hostname for the preview: the CARTO key's referrer
restriction does not allow the short hostname or the IP address.

Known issue: the local unit hard-codes the Tailscale address. When that address
changes, the service loops with `Cannot assign requested address`. Bind
`"$(tailscale ip -4)"` in `ExecStart` instead of a literal address.

## Operating

Ask the owner before restarting a service. Restart after Python changes; a page
refresh is enough for static changes. A Git pull does not restart anything.

```bash
# Status and logs
systemctl status cellmap.service --no-pager
systemctl --user status cellmap-local.service --no-pager
sudo journalctl -u cellmap.service -n 50 --no-pager
journalctl --user -u cellmap-local.service -n 50 --no-pager

# Restart
sudo systemctl restart cellmap.service
systemctl --user restart cellmap-local.service

# Health
curl --fail http://127.0.0.1:8000/api/health
curl --fail "http://$(tailscale ip -4):8001/api/health"
```

After editing a unit file: `sudo systemctl daemon-reload` (system) or
`systemctl --user daemon-reload` (user), then restart that unit.

## Importer integration warning

`scripts/import_csvs.py` can stop, swap and restart website services, but its
defaults still name the obsolete transient user units and it only manages
**user** units. It cannot restart the public **system** unit, and
`--service cellmap.service` does not change that. Until the integration is
adapted, use `--check-only` to build and validate, then swap and restart by
hand. See [scripts/README.md](scripts/README.md#safe-imports-and-rebuilds).
