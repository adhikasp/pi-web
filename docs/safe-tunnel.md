# PI WEB Safe Tunnel

PI WEB includes a local Safe Tunnel UI and server-side bridge for exposing a local PI WEB through the PI WEB Safe Tunnels service.

The connector stays optional. Users who never open or enable Safe Tunnel do not need to install or run `pi-web-tunnel`, and PI WEB does not store connector credentials in PI WEB config.

## Local bridge and connector ownership

- The browser UI is the **Expose Safely** action plus **Settings → Safe Tunnel**.
- The PI WEB web/API process serves local routes under `/api/safe-tunnel/*`.
- The bridge shells out to the connector for `status`, `login`, `start`, and `stop`.
- Connector secrets live in the connector config, normally `~/.config/pi-web-tunnel/config.json`; PI WEB only reads redacted config/runtime state.

## Connector command defaults

Packaged/production PI WEB looks for `pi-web-tunnel` on `PATH` by default. Override it with:

```bash
PI_WEB_SAFE_TUNNEL_CONNECTOR_COMMAND=/absolute/path/to/pi-web-tunnel
```

Source-tree development uses the first-party workspace connector instead. When `PI_WEB_SAFE_TUNNEL_CONNECTOR_COMMAND` is unset and `scripts/pi-web-tunnel-dev.sh` exists, the bridge uses that script before falling back to `pi-web-tunnel`. `pi-web install --dev` also writes the same script path into the development service environment.

The wrapper runs:

```bash
npm --prefix /srv/dev/pi-web run --silent tunnel:connector -- "$@"
```

so bridge calls execute `/srv/dev/pi-web/packages/tunnel-connector/src/cli.ts` through the local npm workspace rather than a wrapper in `/srv/dev/pi-web-tunnels`.

## Useful development commands

```bash
# From /srv/dev/pi-web:
npm run tunnel:connector -- --help
scripts/pi-web-tunnel-dev.sh status

# Run PI WEB dev normally; the bridge will prefer scripts/pi-web-tunnel-dev.sh.
npm run dev:web
```

Run the hosted Safe Tunnels stack from `/srv/dev/pi-web-tunnels` when you need a local Control API, edge, and relay. The connector command used by PI WEB should still point at this repo's wrapper or an installed `pi-web-tunnel` binary.
