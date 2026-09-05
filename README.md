# NEXUS — a small working model

A single-machine model of NEXUS: the platform that sits under a company's
services, moves work between them, survives its own crashes, and explains
what it did. This is not the 40 real services — it's the platform, plus a
sender and a worker written to stand in for them.

Requires **Node.js 18+** (built and tested on v22). Zero external
dependencies — nothing to `npm install`, nothing that needs the internet.

---

## Start

```
cd nexus
node src/core/server.js
```

Success looks like this on first boot:

```
[nexus] replayed 0 event(s) from .../data/events.log
[nexus] 0 work item(s) known after replay
[nexus] Core listening on http://localhost:4000
[nexus] event log: .../data/events.log
[nexus] retry policy: first wait 3000ms, +2000ms each attempt, max 4 attempts before dead-letter
[nexus] sweep processes at most 50 timed-out item(s) per 1000ms tick
```

Nothing else is needed first. `data/events.log` is created automatically —
that one file is the platform's entire durable state.

To run with different settings (all optional, all shown at startup):

```
set NEXUS_RETRY_BASE_MS=3000
set NEXUS_RETRY_BACKOFF_MS=2000
set NEXUS_MAX_ATTEMPTS=4
set NEXUS_HEARTBEAT_STALE_MS=6000
set NEXUS_MAX_BACKLOG=10000
set NEXUS_SWEEP_BATCH_LIMIT=50
set PORT=4000
```

---

## Use (under 2 minutes)

Send some fake work — no second terminal required. If nothing is
currently heartbeating, Core automatically starts one default worker
the moment the first piece of work arrives (set `NEXUS_AUTO_WORKER=0`
to disable this and manage workers by hand instead):

```
curl -X POST http://localhost:4000/work -H "Content-Type: application/json" -d "{\"id\":\"t1\",\"type\":\"demo\",\"body\":{}}"
```

Watch Core's own terminal — you'll see `auto-starting one worker`,
then the worker's own log lines as it picks the item up and finishes it.

To send a batch, or run a worker yourself with specific flags (see
Break below), start them explicitly:

```
node src\sender\sender.js --count=5 --interval=800
node src\worker\worker.js --id=w1 --delay=2000
```

Open **http://localhost:4000/** in a browser to watch the same thing
happen live on the operator view, refreshing on its own every second.

Ask about what happened at any point:

```
curl http://localhost:4000/status
curl "http://localhost:4000/history?id=<a work item id from /status>"
```

---

## Break

Every failure below can be triggered on demand — this is what a reviewer
should actually run, not just read about.

**Kill a worker in the middle of processing a piece of work.**
```
node src\worker\worker.js --id=w1 --delay=8000
curl -X POST http://localhost:4000/work -H "Content-Type: application/json" -d "{\"id\":\"t1\",\"type\":\"demo\",\"body\":{}}"
:: wait ~2s so it's picked up, then, in another terminal:
kill-worker.cmd
```
Watch: `curl http://localhost:4000/work/t1` — stays `"status":"dispatched"`,
visible, never silently lost. (`taskkill /IM node.exe /F` kills Core too,
since both are "node.exe" — `kill-worker.cmd` targets only the process
running `worker.js`.)

**Stop and restart the platform while it is holding work.**
```
:: with work items pending, in Core's terminal:
Ctrl+C
node src\core\server.js
```
Watch the startup line: `replayed N event(s)` — every accepted item is
still there afterward, with the same history, not re-created.

**Make a worker crash every time it starts, so it never recovers.**
```
node src\worker\worker.js --id=poison --crash-on-start
```
Watch: it picks up one item and exits immediately. Left alone, Core's own
sweep retries the item with growing backoff, then marks it
`"status":"dead-lettered"` after the stated attempt limit — never an
infinite loop. Reversible: `curl -X POST http://localhost:4000/debug/revive/<id>`.

**Make a worker slow instead of dead.**
```
node src\worker\worker.js --id=w1 --delay=8000
:: submit an item, then poll during the 8 seconds:
curl http://localhost:4000/workers
```
Watch: `"status":"alive"` the entire time, never `"missing"`, because
heartbeats run on their own timer independent of task completion.

**Cause the same piece of work to be delivered twice.**
```
curl -X POST http://localhost:4000/work -H "Content-Type: application/json" -d "{\"id\":\"d1\",\"type\":\"demo\",\"body\":{}}"
curl "http://localhost:4000/work/next?worker=w1"
curl -X POST http://localhost:4000/debug/force-redeliver/d1
curl -X POST http://localhost:4000/work/d1/done -H "Content-Type: application/json" -d "{\"workerId\":\"w1\"}"
curl -X POST http://localhost:4000/work/d1/done -H "Content-Type: application/json" -d "{\"workerId\":\"w1\"}"
```
Watch: the second `done` call returns `"duplicate":true` and changes
nothing — `curl http://localhost:4000/work/d1` shows one completion time,
plus a recorded (not silent) duplicate report.

**Push out a bad release and then take it back.**
```
curl -X POST http://localhost:4000/release -H "Content-Type: application/json" -d "{\"service\":\"inventory-worker\",\"version\":\"v1\"}"
node src\worker\worker.js --id=w1 --service=inventory-worker --delay=1500
curl -X POST http://localhost:4000/release -H "Content-Type: application/json" -d "{\"service\":\"inventory-worker\",\"version\":\"v2-crash\"}"
curl -X POST http://localhost:4000/work -H "Content-Type: application/json" -d "{\"id\":\"r1\",\"type\":\"demo\",\"body\":{}}"
```
Watch: the worker starts crashing on every item after the bad release.
Roll back in one action:
```
curl -X POST http://localhost:4000/rollback -H "Content-Type: application/json" -d "{\"service\":\"inventory-worker\"}"
```
Restart the worker — it processes normally again. `curl http://localhost:4000/history`
(no filter) shows the release sitting directly next to the failures that
followed it, on one timeline.

**Backlog has a real, enforced limit.**
```
set NEXUS_MAX_BACKLOG=2
node src\core\server.js
:: submit 3 items
```
Watch: the third gets HTTP 503 with a clear `"backlog full"` message, not
silence and not unbounded growth.

**Not handled, on purpose:** making a cached value disagree with the real
value, and taking a dependency away completely. This model has no second
copy of any fact and no external dependency to lose — see ACCOUNT.md Scope.

---

## Look

Operator view: **http://localhost:4000/**

What to notice first: the **banner at the very top**. It states plainly
what's wrong right now (or "Nothing abnormal right now") — not raw
numbers left for you to judge. If something has been given up on, it
also names the most likely cause (a recent release, if one happened
shortly before) directly in that sentence.

Below the banner: backlog and status counts, a workers table (alive /
missing, with heartbeat age), a "given up on" table (attempts, when, and
why), a search box ("Ask about the past") for the full history of any
work item or worker id, and the exact retry/heartbeat/backlog settings
Core is actually running with. The whole page refreshes on its own every
second — no need to reload.
