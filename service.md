# Cellmap

Cellular measurement explorer using a Python HTTP API, DuckDB, Parquet, and a
plain JavaScript frontend. Repository on `ghoshlab2`:
`/home/jpalathi/Documents/Repos/_research/cellmap`.

## Website services

Deployment configured on 2026-09-18:

| Purpose | Service | Listener | URL |
| --- | --- | --- | --- |
| Public website | System service `cellmap.service` | `127.0.0.1:8000` | https://cellmap.joshuaroy873.com |
| Tailnet testing | User service `cellmap-local.service` | `100.85.31.36:8001` | http://ghoshlab2.taila7dab6.ts.net:8001/ |

The public website uses the separate Cloudflare tunnel service. The local
service connects directly over Tailscale, not Cloudflare. Devices on the same
tailnet can use the local URL, subject to tailnet access rules. Use the full
hostname above for CARTO tiles: the short hostname and direct IP URL are not
authorized by the current key's website restrictions. The IP address remains
usable for server health checks.

Both services are enabled at startup. The local service belongs to `jpalathi`;
user lingering is enabled so it can start without an interactive login. It
retries startup if the Tailscale address is not ready yet. Cloudflare and
Tailscale are also enabled at boot.

Both processes use this repository's `.venv/bin/python`, `website/server.py`,
dataset, shared-link store, and CARTO key. The preview is **not an isolated copy**:
source, data, and configuration changes can affect both sites. CARTO must allow
the preview's referrer for its background tiles to work.

### Service files

- Public: `/etc/systemd/system/cellmap.service`
- Local: `/home/jpalathi/.config/systemd/user/cellmap-local.service`

These files live outside Git. The old transient services
`cellmap-server-8000.service` and `cellmap-repo-preview-8001.service` were stopped
and replaced by this setup; do not start them alongside these services.

### Management commands

Run as `jpalathi` on the server:

```bash
# Status
systemctl status cellmap.service --no-pager
systemctl --user status cellmap-local.service --no-pager

# Restart after backend changes
sudo systemctl restart cellmap.service
systemctl --user restart cellmap-local.service

# Logs
sudo journalctl -u cellmap.service -n 50 --no-pager
journalctl --user -u cellmap-local.service -n 50 --no-pager

# Health
curl --fail http://127.0.0.1:8000/api/health
curl --fail http://100.85.31.36:8001/api/health
```

After editing a service file, run `sudo systemctl daemon-reload` for the public
service or `systemctl --user daemon-reload` for the local service, then restart
that service. A Git pull alone does not restart the Python processes.

## Importer integration warning

The importer still targets the old transient **user** service names and only
manages user services. It has not yet been adapted to the public **system**
service plus `cellmap-local`. Do not rely on automatic import activation with
this deployment until that integration is updated. `--service cellmap.service`
alone does not solve the system/user distinction. `--check-only` remains
available to build and validate without stopping services or swapping data.

## Further documentation

- [CSV import and rebuild guide](scripts/README.md)
- [Website, API, and basemap configuration](website/README.md)
- [Data layout](data/README.md)
- [Remaining work](todos.md)

Keep `.env` and measurement data out of Git. `AI_CONTEXT.md` is a Git-ignored
local handoff document.
