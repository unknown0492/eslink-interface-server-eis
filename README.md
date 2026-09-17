# esLink Interface Server (EIS)

Drains `endpoint_delivery_queue` and delivers guest events to each property's
configured endpoints.

## What it does

```
gcin_hms() / gcout_hms() / gchng_hms()
        |
        v
endpoint_delivery_queue  (one row per endpoint, status = pending)
        |
        |  PHP pings POST /api/queue/trigger
        v
       EIS  --> claims rows --> POST to endpoint_url --> marks delivered
```

Deliveries are **not** made from PHP. A request-scoped process cannot retry,
and a slow endpoint would hold an Apache worker open while the PMS waits for
its ACK.

## Scope

This build covers queue drain and delivery only. Not included yet:

- WebSocket server for the Java interface clients
- Live status writes to `interface_configurations` / `property_pms` / `endpoints`
- Heartbeat staleness monitoring

## Install

```bash
cd /path/to/eis
npm install
cp .env.example .env
nano .env          # fill in DB_USER, DB_PASSWORD, APP_SECRET
mkdir -p logs
```

Start under PM2:

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Check it is alive:

```bash
curl http://127.0.0.1:3222/health
curl http://127.0.0.1:3222/api/queue/status
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/queue/trigger` | Wake the drain. Returns immediately. |
| GET | `/api/queue/status` | Queue depth and runtime counters. |
| GET | `/health` | Liveness check. |

Bound to `127.0.0.1` by default, so none of these are reachable from outside
the VPS.

## Key behaviours

**Per-room FIFO.** A row is only claimed when no earlier row for the same
property, endpoint and room is still pending or in flight. This is what stops
a check-out overtaking a check-in.

**Passes never overlap.** A trigger arriving mid-drain sets a flag; the
current pass repeats when it finishes.

**Endpoint pacing.** `QUEUE_ENDPOINT_PACING` puts a gap between two deliveries
to the same endpoint. Each delivery to an NCS endpoint restarts RADIUS on that
box and drops live guest sessions, so draining a backlog at full speed would
repeatedly kick the whole hotel off the WiFi.

**Crash recovery.** Rows left `in_flight` by a kill are returned to `pending`
at boot. Without this they would block their room's queue forever.

**Retry and expiry.** Failures retry after `QUEUE_RETRY_DELAY` (5 min) until
`QUEUE_MAX_AGE` (24 h), then become `expired` and are reported once by email.
Expired rows are kept, not deleted.

## Failure notifications

EIS never sends SMTP. It calls `eslink_send_notification_email` on
eslink.online so mail credentials stay in one place.

One email when an endpoint starts failing, one every 15 minutes while it
stays down, one on recovery — each quoting the current backlog rather than
one email per queued row.
