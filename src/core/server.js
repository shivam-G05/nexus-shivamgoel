const http = require('http');
const path = require('path');
const fs = require('fs');
const { createEventLog } = require('./eventLog');

const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const LOG_FILE = process.env.NEXUS_LOG || path.join(__dirname, '..', '..', 'data', 'events.log');

// Retry policy - production principle 09 says these must be visible, not
// buried in code, so they're all overridable and printed at startup.
const RETRY_BASE_MS = Number(process.env.NEXUS_RETRY_BASE_MS || 3000);
const RETRY_BACKOFF_MS = Number(process.env.NEXUS_RETRY_BACKOFF_MS || 2000);
const MAX_ATTEMPTS = Number(process.env.NEXUS_MAX_ATTEMPTS || 4);
const SWEEP_INTERVAL_MS = 1000;

// A worker is "alive" if a heartbeat arrived recently - this is judged
// entirely separately from whether it has finished its current task,
// which is the whole fix for the slow-worker-mistaken-for-dead bug.
const HEARTBEAT_STALE_MS = Number(process.env.NEXUS_HEARTBEAT_STALE_MS || 6000);

// A stated, enforced ceiling on how much can be in flight at once -
// hitting it produces a clear rejection, never silent unbounded growth.
const MAX_BACKLOG = Number(process.env.NEXUS_MAX_BACKLOG || 10000);

// R-11: recovery does no harm. If a huge batch of items all time out in
// the same second (e.g. a worker died holding a lot of dispatched work),
// sweep() only acts on this many per tick instead of writing thousands
// of log lines in one synchronous burst - the rest catch up on the next
// tick, a second later, instead of all landing on Core at once.
const SWEEP_BATCH_LIMIT = Number(process.env.NEXUS_SWEEP_BATCH_LIMIT || 50);

// Rule 05 / production principle 02: fail loudly at startup, not quietly
// three requests later.
if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error(`[nexus] bad PORT value: "${process.env.PORT}" - refusing to start`);
  process.exit(1);
}
if (![RETRY_BASE_MS, RETRY_BACKOFF_MS, MAX_ATTEMPTS, HEARTBEAT_STALE_MS, MAX_BACKLOG, SWEEP_BATCH_LIMIT].every((n) => Number.isFinite(n) && n > 0)) {
  console.error('[nexus] bad config env vars - refusing to start');
  process.exit(1);
}

// Wait longer after every attempt: attempt 1 waits RETRY_BASE_MS,
// attempt 2 waits RETRY_BASE_MS + RETRY_BACKOFF_MS, and so on. A
// permanent fault costs less and less attention while it stays broken.
function timeoutForAttempt(attempts) {
  return RETRY_BASE_MS + Math.max(0, attempts - 1) * RETRY_BACKOFF_MS;
}

const log = createEventLog(LOG_FILE);

// In-memory state. This is a cache of the log, not a second source of
// truth - it is rebuilt from the log every time Core boots, and nothing
// is ever trusted here that isn't already on disk.
// Status moves WAITING -> DISPATCHED -> DONE (Phase 4 adds DEAD-LETTERED
// on top of this same shape - see the lifecycle diagram in the blueprint).
const work = new Map();

// One version pointer per named stand-in service. Unlike worker
// heartbeats, this IS durable - a release is a decision, not a "right
// now" fact - so it's rebuilt from the log on boot like everything else.
// service -> { current, previous }
const releases = new Map();

function applyEvent(event) {
  if (event.type === 'accepted') {
    work.set(event.id, {
      id: event.id,
      workType: event.workType,
      body: event.body,
      status: 'waiting',
      acceptedAt: event.ts,
      attempts: 0,
      duplicateReports: []
    });
  } else if (event.type === 'dispatched') {
    const item = work.get(event.id);
    // A (re)dispatch is never allowed to regress an item that is
    // already DONE - this is what stops a late or forced redelivery
    // event from corrupting a completed item's record.
    if (item && item.status !== 'done') {
      item.status = 'dispatched';
      item.dispatchedTo = event.workerId;
      item.dispatchedAt = event.ts;
      item.attempts = (item.attempts || 0) + 1;
    }
  } else if (event.type === 'done') {
    const item = work.get(event.id);
    if (item) {
      item.status = 'done';
      item.doneBy = event.workerId;
      item.doneAt = event.ts;
    }
  } else if (event.type === 'duplicate_completion_ignored') {
    const item = work.get(event.id);
    if (item) {
      item.duplicateReports = item.duplicateReports || [];
      item.duplicateReports.push({ at: event.ts, workerId: event.workerId });
    }
  } else if (event.type === 'dead_lettered') {
    const item = work.get(event.id);
    if (item) {
      item.status = 'dead-lettered';
      item.deadLetteredAt = event.ts;
      item.deadLetterReason = event.reason;
    }
  } else if (event.type === 'revived') {
    const item = work.get(event.id);
    // Giving up is reversible: an operator can put a dead-lettered item
    // back to WAITING with a clean budget, without restarting Core.
    if (item && item.status === 'dead-lettered') {
      item.status = 'waiting';
      item.attempts = 0;
      item.deadLetteredAt = null;
      item.deadLetterReason = null;
    }
  } else if (event.type === 'release') {
    releases.set(event.service, { current: event.version, previous: event.previousVersion });
  } else if (event.type === 'rollback') {
    releases.set(event.service, { current: event.to, previous: null });
  }
}

function currentVersion(service) {
  const r = releases.get(service);
  return r ? r.current : 'v1';
}

// Runs once a second. Looks only at DISPATCHED items - anything WAITING,
// DONE, or already DEAD-LETTERED is untouched. This is the same "hand it
// out again" action as force-redeliver, just triggered by a timeout
// instead of a human, and it is the one place attempts can turn into a
// dead letter instead of another retry.
function sweep() {
  const now = Date.now();
  let actioned = 0;
  for (const item of work.values()) {
    if (actioned >= SWEEP_BATCH_LIMIT) break; // R-11: spread a big backlog over several ticks, not one burst
    if (item.status !== 'dispatched') continue;
    const elapsed = now - new Date(item.dispatchedAt).getTime();
    if (elapsed <= timeoutForAttempt(item.attempts)) continue;

    const attemptThatTimedOut = item.attempts; // read BEFORE applyEvent mutates it
    actioned += 1;

    if (item.attempts >= MAX_ATTEMPTS) {
      const event = log.append({
        type: 'dead_lettered',
        id: item.id,
        reason: `exceeded ${MAX_ATTEMPTS} attempts (last sent to ${item.dispatchedTo})`
      });
      applyEvent(event);
      console.log(`[nexus] ${item.id} dead-lettered after ${attemptThatTimedOut} attempts`);
    } else {
      const event = log.append({ type: 'dispatched', id: item.id, workerId: item.dispatchedTo, auto: true });
      applyEvent(event);
      console.log(`[nexus] ${item.id} timed out waiting on attempt ${attemptThatTimedOut} - auto-retrying (attempt ${attemptThatTimedOut + 1})`);
    }
  }
}

// Oldest waiting item first. Map iteration order in JS is insertion
// order, so the first WAITING item we hit while scanning is already the
// oldest one - no sorting needed at this scale (a few thousand items).
function pickNextWaiting() {
  for (const item of work.values()) {
    if (item.status === 'waiting') return item;
  }
  return null;
}

function statusCounts() {
  const counts = { waiting: 0, dispatched: 0, done: 0, 'dead-lettered': 0 };
  for (const item of work.values()) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

// Items still "in flight" - the number a bounded backlog is measured
// against. DONE and DEAD-LETTERED are resolved, not backlog.
function backlogSize() {
  let n = 0;
  for (const item of work.values()) {
    if (item.status === 'waiting' || item.status === 'dispatched') n += 1;
  }
  return n;
}

// Worker liveness is a "right now" fact, not a durable one - unlike work
// items, it is intentionally NEVER written to the event log or replayed.
// A freshly restarted Core has no opinion about who's alive until
// heartbeats start arriving again; that is the honest answer, not a gap.
const workers = new Map(); // workerId -> { firstSeenAt, lastHeartbeatAt }

function workerHealth(workerId) {
  const w = workers.get(workerId);
  if (!w) return { known: false };
  const ageMs = Date.now() - w.lastHeartbeatAt;
  return {
    known: true,
    firstSeenAt: new Date(w.firstSeenAt).toISOString(),
    lastHeartbeatAt: new Date(w.lastHeartbeatAt).toISOString(),
    heartbeatAgeMs: ageMs,
    // "alive", never "busy" vs "dead" conflated with task progress - a
    // worker mid-way through a slow item still heartbeats on schedule.
    status: ageMs <= HEARTBEAT_STALE_MS ? 'alive' : 'missing'
  };
}

function workersSummary() {
  return Array.from(workers.keys()).map((id) => ({ id, ...workerHealth(id) }));
}

const HISTORY_DEFAULT_LIMIT = 200;
const HISTORY_MAX_LIMIT = 2000;

// "Ask about the past" (R-05) reads straight from the same diary that
// durability (R-01) is built on - there is no separate history store to
// keep in sync, and nothing here can disagree with what /status shows,
// because both ultimately trace back to this one file.
//
// How far back you can ask: the whole log, since this data file was
// created. There is no retention/rotation policy at this size (a few
// thousand items) - stated here as a deliberate choice, not a silent gap.
function queryHistory({ id, worker, type, since, until, limit }) {
  let events = log.replay();
  if (id) events = events.filter((e) => e.id === id);
  if (worker) events = events.filter((e) => e.workerId === worker);
  if (type) events = events.filter((e) => e.type === type);
  if (since) {
    const t = new Date(since).getTime();
    events = events.filter((e) => new Date(e.ts).getTime() >= t);
  }
  if (until) {
    const t = new Date(until).getTime();
    events = events.filter((e) => new Date(e.ts).getTime() <= t);
  }
  const max = Math.min(Number(limit) || HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);
  const truncated = events.length > max;
  if (truncated) events = events.slice(-max); // most recent `max` events
  return { events, truncated };
}

function bootstrap() {
  const events = log.replay();
  for (const event of events) applyEvent(event);
  console.log(`[nexus] replayed ${events.length} event(s) from ${LOG_FILE}`);
  console.log(`[nexus] ${work.size} work item(s) known after replay`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  try {
    // The operator view. Reads only from the same endpoints below
    // (/status, /workers, /config) - no separate data path a reviewer
    // has to trust is kept in sync with what the API actually says.
    if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
      let html;
      try {
        html = fs.readFileSync(DASHBOARD_FILE, 'utf8');
      } catch (err) {
        return send(res, 500, { error: `dashboard file missing: ${err.message}` });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'POST' && req.url === '/work') {
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        return send(res, 400, { error: 'body must be valid JSON' });
      }
      if (!payload.id || !payload.type) {
        return send(res, 400, { error: 'work item needs an "id" and a "type"' });
      }
      if (work.has(payload.id)) {
        // Say so explicitly - never silently re-accept the same id.
        return send(res, 200, { accepted: true, id: payload.id, duplicate: true });
      }
      if (backlogSize() >= MAX_BACKLOG) {
        // Explicit, visible rejection - never pile work up until the
        // machine falls over, and never drop it without saying so.
        return send(res, 503, {
          error: `backlog full: ${backlogSize()}/${MAX_BACKLOG} items already in flight`,
          accepted: false
        });
      }
      // Append BEFORE responding. If Core is killed the instant after
      // this line, the item is already safe on disk.
      const event = log.append({
        type: 'accepted',
        id: payload.id,
        workType: payload.type,
        body: payload.body ?? null
      });
      applyEvent(event);
      return send(res, 200, { accepted: true, id: payload.id });
    }

    if (req.method === 'GET' && req.url === '/status') {
      return send(res, 200, {
        totalKnown: work.size,
        counts: statusCounts(),
        backlog: { size: backlogSize(), max: MAX_BACKLOG },
        items: Array.from(work.values())
      });
    }

    // Independent of task completion - a worker sends this on its own
    // timer regardless of whether it's mid-processing something slow.
    // This is the entire mechanism behind "alive" vs "dead" not being
    // confused with "hasn't finished yet".
    if (req.method === 'POST' && /^\/worker\/[^/]+\/heartbeat$/.test(req.url)) {
      const id = decodeURIComponent(req.url.split('/')[2]);
      let payload = {};
      try { payload = await readJsonBody(req); } catch { /* pid is optional */ }
      const now = Date.now();
      const existing = workers.get(id);
      workers.set(id, {
        firstSeenAt: existing ? existing.firstSeenAt : now,
        lastHeartbeatAt: now,
        pid: payload.pid || (existing ? existing.pid : null)
      });
      return send(res, 200, { ok: true, id });
    }

    // Lets the operator view actually end a specific worker process, not
    // just watch it - uses the pid the worker last reported on its own
    // heartbeat. A real termination signal, the same as kill-worker.cmd.
    if (req.method === 'POST' && /^\/debug\/kill-worker\/[^/]+$/.test(req.url)) {
      const id = decodeURIComponent(req.url.split('/')[3]);
      const w = workers.get(id);
      if (!w || !w.pid) {
        return send(res, 404, { error: `no known process id for worker "${id}" - has it sent a heartbeat since this feature was added?` });
      }
      try {
        process.kill(w.pid);
        return send(res, 200, { ok: true, id, pid: w.pid, note: 'termination signal sent' });
      } catch (err) {
        return send(res, 200, { ok: true, id, pid: w.pid, note: `process may already be gone: ${err.message}` });
      }
    }

    if (req.method === 'GET' && req.url === '/workers') {
      return send(res, 200, { staleAfterMs: HEARTBEAT_STALE_MS, workers: workersSummary() });
    }

    // R-06 (CORE): push a new version for a named stand-in service.
    // Logged into the SAME event stream as work/dispatch/etc - that one
    // shared timeline is what gives R-07 (release linked to what
    // followed) to the dashboard/history views for free.
    if (req.method === 'POST' && req.url === '/release') {
      let payload;
      try { payload = await readJsonBody(req); } catch { return send(res, 400, { error: 'body must be valid JSON' }); }
      const service = payload.service || 'default';
      const version = payload.version;
      if (!version) return send(res, 400, { error: 'release needs a "version"' });
      const prior = releases.get(service);
      const previousVersion = prior ? prior.current : null;
      const event = log.append({ type: 'release', service, version, previousVersion });
      applyEvent(event);
      return send(res, 200, { ok: true, service, version, previousVersion });
    }

    // "Know how to undo before doing": if there is no recorded previous
    // version, rollback refuses with a clear reason instead of guessing.
    // One action, one known result - no state to reconstruct by hand.
    if (req.method === 'POST' && req.url === '/rollback') {
      let payload;
      try { payload = await readJsonBody(req); } catch { return send(res, 400, { error: 'body must be valid JSON' }); }
      const service = payload.service || 'default';
      const r = releases.get(service);
      if (!r || !r.previous) {
        return send(res, 400, { error: `no previous version known for "${service}" - cannot roll back` });
      }
      const rolledBackFrom = r.current;
      const event = log.append({ type: 'rollback', service, from: rolledBackFrom, to: r.previous });
      applyEvent(event);
      return send(res, 200, { ok: true, service, version: r.previous, rolledBackFrom });
    }

    // Stand-in workers poll this to find out what version they should
    // be behaving as - this is how a release actually changes live
    // behaviour instead of only changing a number in Core's memory.
    if (req.method === 'GET' && req.url.startsWith('/version')) {
      const url = new URL(req.url, 'http://internal');
      const service = url.searchParams.get('service') || 'default';
      return send(res, 200, { service, version: currentVersion(service) });
    }

    if (req.method === 'GET' && req.url === '/releases') {
      return send(res, 200, {
        services: Array.from(releases.entries()).map(([service, r]) => ({ service, ...r }))
      });
    }

    // R-05: for any recent period, what was the platform asked to do,
    // what did it do, and why. Every filter is optional and combinable.
    if (req.method === 'GET' && req.url.startsWith('/history')) {
      const url = new URL(req.url, 'http://internal');
      const { events, truncated } = queryHistory({
        id: url.searchParams.get('id'),
        worker: url.searchParams.get('worker'),
        type: url.searchParams.get('type'),
        since: url.searchParams.get('since'),
        until: url.searchParams.get('until'),
        limit: url.searchParams.get('limit')
      });
      return send(res, 200, { count: events.length, truncated, events });
    }

    // Production principle 09: the settings actually in force, visible
    // on demand instead of buried in source a reviewer has to go read.
    if (req.method === 'GET' && req.url === '/config') {
      return send(res, 200, {
        port: PORT,
        logFile: LOG_FILE,
        retry: { firstWaitMs: RETRY_BASE_MS, backoffMs: RETRY_BACKOFF_MS, maxAttempts: MAX_ATTEMPTS },
        heartbeatStaleMs: HEARTBEAT_STALE_MS,
        maxBacklog: MAX_BACKLOG,
        sweepBatchLimit: SWEEP_BATCH_LIMIT
      });
    }

    // A worker asks for the next item. Picking the item, appending the
    // "dispatched" event, and replying all happen with no `await` in
    // between - Node's single thread means nothing else can interleave,
    // so two workers can never be handed the same waiting item.
    if (req.method === 'GET' && req.url.startsWith('/work/next')) {
      const url = new URL(req.url, 'http://internal');
      const workerId = url.searchParams.get('worker') || 'unknown-worker';
      const next = pickNextWaiting();
      if (!next) return send(res, 200, { item: null });
      const event = log.append({ type: 'dispatched', id: next.id, workerId });
      applyEvent(event);
      return send(res, 200, { item: work.get(next.id) });
    }

    if (req.method === 'POST' && /^\/work\/[^/]+\/done$/.test(req.url)) {
      const id = decodeURIComponent(req.url.split('/')[2]);
      const item = work.get(id);
      if (!item) return send(res, 404, { error: 'unknown work id' });
      let payload = {};
      try { payload = await readJsonBody(req); } catch { /* ignore, workerId is optional */ }
      const workerId = payload.workerId || 'unknown-worker';

      if (item.status === 'done') {
        // Exactly INC-2291's "worker says done after we'd already
        // resent the work": the first completion stays authoritative,
        // this report is recorded but changes nothing.
        const event = log.append({ type: 'duplicate_completion_ignored', id, workerId });
        applyEvent(event);
        return send(res, 200, {
          ok: true, id, status: 'done', duplicate: true,
          note: 'already done - this report changed nothing'
        });
      }

      const event = log.append({ type: 'done', id, workerId });
      applyEvent(event);
      return send(res, 200, { ok: true, id, status: 'done' });
    }

    // Fault-injection control (Thing 04 / R-15): forces Core to hand
    // this item out again even though it's still "in flight", the same
    // way an automatic timeout will in Phase 04. Only works on an item
    // that is currently dispatched - there is nothing sensible to
    // "redeliver" for one that's still waiting or already done.
    if (req.method === 'POST' && /^\/debug\/force-redeliver\/[^/]+$/.test(req.url)) {
      const id = decodeURIComponent(req.url.split('/')[3]);
      const item = work.get(id);
      if (!item) return send(res, 404, { error: 'unknown work id' });
      if (item.status !== 'dispatched') {
        return send(res, 400, {
          error: `cannot force-redeliver a "${item.status}" item - only a currently-dispatched item can be resent`,
          status: item.status
        });
      }
      const event = log.append({ type: 'dispatched', id, workerId: item.dispatchedTo, forced: true });
      applyEvent(event);
      return send(res, 200, {
        ok: true, id, attempts: work.get(id).attempts,
        note: 'redelivered - the original attempt may still complete and race this one'
      });
    }

    // Giving up is visible AND reversible: an operator can put a
    // dead-lettered item back into play without restarting Core.
    if (req.method === 'POST' && /^\/debug\/revive\/[^/]+$/.test(req.url)) {
      const id = decodeURIComponent(req.url.split('/')[3]);
      const item = work.get(id);
      if (!item) return send(res, 404, { error: 'unknown work id' });
      if (item.status !== 'dead-lettered') {
        return send(res, 400, {
          error: `cannot revive a "${item.status}" item - only a dead-lettered item can be revived`,
          status: item.status
        });
      }
      const event = log.append({ type: 'revived', id });
      applyEvent(event);
      return send(res, 200, { ok: true, id, status: work.get(id).status });
    }

    if (req.method === 'GET' && req.url.startsWith('/work/')) {
      const id = decodeURIComponent(req.url.slice('/work/'.length));
      const item = work.get(id);
      if (!item) return send(res, 404, { error: 'unknown work id' });
      return send(res, 200, item);
    }

    send(res, 404, { error: 'no such route' });
  } catch (err) {
    console.error('[nexus] request failed:', err.message);
    send(res, 500, { error: 'internal error' });
  }
});

bootstrap();
server.listen(PORT, () => {
  console.log(`[nexus] Core listening on http://localhost:${PORT}`);
  console.log(`[nexus] event log: ${LOG_FILE}`);
  console.log(`[nexus] retry policy: first wait ${RETRY_BASE_MS}ms, +${RETRY_BACKOFF_MS}ms each attempt, max ${MAX_ATTEMPTS} attempts before dead-letter`);
  console.log(`[nexus] sweep processes at most ${SWEEP_BATCH_LIMIT} timed-out item(s) per ${SWEEP_INTERVAL_MS}ms tick`);
});
setInterval(sweep, SWEEP_INTERVAL_MS);
