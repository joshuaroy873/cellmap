# Cellmap

Explorer for QualiPoc cellular drive-test measurements (LTE and 5G NR). A Python
HTTP API queries DuckDB over Parquet partitions; the browser renders maps, time
series and CDF curves with plain JavaScript and Leaflet. There is no build step.

## Quick start

```bash
.venv/bin/python scripts/import_csvs.py /path/to/csv-folder   # build the dataset
printf 'CARTO_BASEMAP_KEY=your-key\n' > .env                   # basemap tiles
.venv/bin/python website/server.py                             # http://127.0.0.1:8000
```

## Layout

```text
cellmap_schema.py        canonical columns, metrics, import rules, shared DuckDB config
cellmap_geo.py           collection bounds and the Geo-poly polygon/grid search
scripts/import_csvs.py   the one data-management command (import, rebuild, delete)
website/server.py        HTTP API and static file server
website/compare_api.py   Compare-tab batch CDF queries
website/static/          frontend (one file per tab plus shared helpers)
data/                    measurement data; Git-ignored except its README
tests/                   regression tests: .venv/bin/python -m unittest discover -s tests
```

## Documentation

- [service.md](service.md): deployment, services, restarts
- [website/README.md](website/README.md): configuration, API, UI behaviour
- [scripts/README.md](scripts/README.md): importing, rebuilding, schema
- [data/README.md](data/README.md): data folder layout and safety
- [todos.md](todos.md): remaining work

Git ignores measurement data, `.env`, and the local `AI_CONTEXT.md`.
