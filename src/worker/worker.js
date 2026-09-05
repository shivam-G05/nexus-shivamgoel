const http = require('http');

const CORE_URL = process.env.NEXUS_CORE || 'http://localhost:4000';
const WORKER_ID = (process.argv.find((a) => a.startsWith('--id=')) || '--id=w1').split('=')[1];
const PROCESS_MS = Number((process.argv.find((a) => a.startsWith('--delay=')) || '--delay=2000').split('=')[1]);
const CRASH_ON_START = process.argv.includes('--crash-on-start');
const SERVICE = (process.argv.find((a) => a.startsWith('--service=')) || '--service=default').split('=')[1];
const POLL_MS = 1000;
const HEARTBEAT_MS = 2000;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(out)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// A worker only ever has one item in flight at a time - simple, and
// enough at this scale. Killing this process mid-timeout (mid-"processing")
// is exactly the Phase 2 break-test: the item is left DISPATCHED in Core,
// visible on /status, not lost and not silently re-attempted yet
// (automatic retry is Phase 4's job, not this one's).
let busy = false;

async function tick() {
  if (busy) return;
  try {
    const res = await getJson(`${CORE_URL}/work/next?worker=${WORKER_ID}`);
    if (!res.item) return;
    busy = true;
    const item = res.item;

    if (CRASH_ON_START) {
      console.log(`[${WORKER_ID}] picked up ${item.id} - simulating a crash instead of processing it`);
      process.exit(1);
    }

    // Behaviour actually changes with the release, not just a number in
    // Core's memory: this worker checks what version it's meant to be
    // running every time it picks up work, and a "*crash*" version
    // reproduces the exact INC-2291 shape - correct code, bad release.
    let version = 'v1';
    try {
      const v = await getJson(`${CORE_URL}/version?service=${encodeURIComponent(SERVICE)}`);
      version = v.version;
    } catch { /* if Core is unreachable there's nothing sensible to do here */ }
    if (version.includes('crash')) {
      console.log(`[${WORKER_ID}] picked up ${item.id} - running release "${version}" for service "${SERVICE}", which crashes on every item`);
      process.exit(1);
    }

    console.log(`[${WORKER_ID}] picked up ${item.id} (${item.workType}) - "processing" for ${PROCESS_MS}ms [service=${SERVICE} version=${version}]`);
    setTimeout(async () => {
      try {
        await postJson(`${CORE_URL}/work/${encodeURIComponent(item.id)}/done`, { workerId: WORKER_ID });
        console.log(`[${WORKER_ID}] done: ${item.id}`);
      } catch (err) {
        console.error(`[${WORKER_ID}] failed to report done for ${item.id}:`, err.message);
      } finally {
        busy = false;
      }
    }, PROCESS_MS);
  } catch (err) {
    console.error(`[${WORKER_ID}] poll against ${CORE_URL} failed:`, err.message);
  }
}

// Runs on its own timer, completely independent of tick()'s busy flag -
// this keeps beating on schedule even while an item is mid-"processing".
// A worker that's merely slow never goes quiet the way a dead one does.
function sendHeartbeat() {
  // Sending our own pid lets Core (and the dashboard) actually kill this
  // exact process on request, not just mark it missing after the fact.
  postJson(`${CORE_URL}/worker/${encodeURIComponent(WORKER_ID)}/heartbeat`, { pid: process.pid }).catch((err) => {
    console.error(`[${WORKER_ID}] heartbeat failed:`, err.message);
  });
}

console.log(`[${WORKER_ID}] starting - polling ${CORE_URL} every ${POLL_MS}ms, each item "takes" ${PROCESS_MS}ms, heartbeat every ${HEARTBEAT_MS}ms`);
sendHeartbeat();
setInterval(sendHeartbeat, HEARTBEAT_MS);
setInterval(tick, POLL_MS);
