# Fleet Service Design

Future architecture for running fleet as a persistent service with observability.

## Current State: Script Execution

Today we run fleet ops two ways:
1. **HTTP server** (`npx tsx packages/server/src/index.ts`) — works but crashes under load, no process management
2. **Direct scripts** (`node --import tsx/esm scripts/live-fleet-run.ts`) — more reliable for one-offs

Both require manual startup and have no log persistence.

## Target: Managed Service

### Process Management

Use `pm2` or a systemd unit for the fleet server:

```bash
# pm2 approach
pm2 start "doppler run --project openclaw --config dev -- \
  npx tsx packages/server/src/index.ts" \
  --name fleet-server \
  --log /Users/user/.openclaw/workspace/fleet/logs/fleet.log \
  --time

# Check status
pm2 status fleet-server

# View logs
pm2 logs fleet-server --lines 50

# Restart
pm2 restart fleet-server
```

### Structured Logging

Replace `console.log` with a structured logger (pino or winston):

```ts
// Before
console.log(`pump-it-up server listening on http://localhost:${port}`);

// After
logger.info({ port }, "server listening");
```

Benefits:
- JSON logs → parseable, searchable
- Log levels (debug/info/warn/error)
- Request/response logging middleware
- Trade execution audit trail with structured fields

### Log Location

```
/Users/user/.openclaw/workspace/fleet/logs/
├── fleet.log          # current log (rotated daily)
├── fleet-error.log    # errors only
└── archive/           # rotated logs
```

### Health Monitoring

The server already has `GET /health`. Add:
- Startup timestamp
- Last trade timestamp
- Active fleet count
- Master SA balance (cached, refreshed periodically)

```ts
GET /health
{
  "ok": true,
  "uptime": 3600,
  "lastTrade": "2026-02-20T02:30:00Z",
  "activeFleets": 2,
  "masterBalanceEth": "0.0094"
}
```

## Target: OpenClaw Skill

### Skill Structure

```
skills/fleet-ops/
├── SKILL.md           # Agent instructions (exists)
├── scripts/
│   ├── start.sh       # Start fleet server
│   ├── stop.sh        # Stop fleet server
│   ├── status.sh      # Check server + dashboard
│   └── logs.sh        # Tail recent logs
└── templates/
    └── fleet-report.md  # Template for P&L reports
```

### Agent Integration

The skill should let any OpenClaw session:
1. **Start/stop** the fleet server via skill scripts
2. **Execute operations** via HTTP API (curl from scripts)
3. **Report status** in Kelley-friendly format
4. **Handle errors** with clear recovery steps

### ClawHub Publishing

Once stable:
```bash
clawhub publish skills/fleet-ops --name fleet-ops --private
```

## Migration Checklist

- [ ] Add `pino` logger (replace all `console.log/error`)
- [ ] Add request logging middleware
- [ ] Add pm2 ecosystem config (`ecosystem.config.cjs`)
- [ ] Add log rotation config
- [ ] Add health endpoint enhancements (uptime, lastTrade)
- [ ] Add skill scripts (start/stop/status/logs)
- [ ] Add error recovery documentation
- [ ] Test cold-start from skill (fresh session, no prior context)
- [ ] Publish to ClawHub (private)
