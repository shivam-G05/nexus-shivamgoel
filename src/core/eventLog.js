const fs = require('fs');
const path = require('path');

// The event log is the whole trick behind R-01 (accepted work survives a
// crash). Every state change is appended here BEFORE Core acts on it or
// tells anyone it happened. On restart, Core doesn't trust its memory —
// it replays this file from line one and rebuilds state from scratch.
// Startup and crash-recovery end up being the exact same code path.
function createEventLog(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '');

  function append(event) {
    const record = { ...event, ts: event.ts || new Date().toISOString() };
    const line = JSON.stringify(record) + '\n';
    // Synchronous write: this call does not return until the line is
    // handed to the OS. Core never responds "accepted" before this
    // returns - that ordering is the entire durability guarantee.
    fs.appendFileSync(filePath, line);
    return record;
  }

  function replay() {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`corrupt log line ${i + 1} in ${filePath}: ${err.message}`);
      }
    });
  }

  return { append, replay, filePath };
}

module.exports = { createEventLog };
