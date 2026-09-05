const http = require('http');

const CORE_URL = process.env.NEXUS_CORE || 'http://localhost:4000';
const INTERVAL_MS = Number((process.argv.find((a) => a.startsWith('--interval=')) || '--interval=1500').split('=')[1]);
const countArg = process.argv.find((a) => a.startsWith('--count='));
const COUNT = countArg ? Number(countArg.split('=')[1]) : null;

// Cycled, not random - Rule 04 (same inputs, same behaviour) applies to
// the platform, but there is no reason to make even the demo data
// generator non-deterministic when it costs nothing to avoid.
const WORK_TYPES = ['send-confirmation', 'update-inventory', 'charge-payment'];
let sent = 0;

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

async function sendOne() {
  sent += 1;
  const id = `order-${Date.now()}-${sent}`;
  const type = WORK_TYPES[sent % WORK_TYPES.length];
  try {
    const res = await postJson(`${CORE_URL}/work`, { id, type, body: { seq: sent } });
    console.log(`[sender] sent ${id} (${type}) ->`, JSON.stringify(res));
  } catch (err) {
    console.error(`[sender] failed to send ${id}:`, err.message);
  }
  if (COUNT && sent >= COUNT) {
    console.log(`[sender] sent ${sent} item(s), stopping`);
    process.exit(0);
  }
}

console.log(`[sender] sending work to ${CORE_URL} every ${INTERVAL_MS}ms${COUNT ? ` (${COUNT} total, then stop)` : ' (until stopped)'}`);
sendOne();
if (!COUNT || COUNT > 1) setInterval(sendOne, INTERVAL_MS);
