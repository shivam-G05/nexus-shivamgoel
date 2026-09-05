# Account

## Scope

Built deep: reliable work delivery (R-01 accepted work is safe, R-02
every piece ends somewhere, R-03 doing it twice is harmless, R-04 trying
again has a limit) and observability (R-05 you can ask about the past).
These were chosen because, mapped against the handbook's own six
subsystems, this pair covers 5 of the 6 CORE requirements and directly
feeds the mandatory operator view — the highest-leverage combination
available in the time given.

Built light, on purpose: releasing (R-06 changes can be undone) — one
version pointer per named service, one action to undo, refusing cleanly
when there's nothing to undo to. This is the CORE requirement's exact
wording, without Section 3.2's deeper machinery (a watching period,
judging behaviour rather than aliveness, controlling overlapping
releases).

Reached as stretch, only once 01–08 were solid: R-12 (a likely-cause
hint on the dashboard, correlating a dead-lettered item against the most
recent prior release) and R-11 (a per-tick cap on how many timed-out
items the platform's own recovery sweep acts on at once, so a large
simultaneous backlog drains over several seconds instead of one burst).

Deliberately not built: R-08 (disagreements are found), R-09 (copied
values carry their age), R-10 (degrading is honest) — these live in
Section 3.3 (data copies disagreeing) and 3.5 (caching), a different
subsystem from the focus area. This model also has no second copy of
any fact and no external dependency to lose without inventing one
solely to demonstrate it, which would have spent time on breadth
instead of depth. R-13 (order only claimed when known) and R-14 (the
platform can be asked about itself) — Extended tier, not reached.

## Decisions

**Storage: one append-only file, no database.** Every state change is
written as a JSON line before Core acts on it or responds. At this
scale (a few thousand items) a single process writing sequentially has
no concurrency problem a database would solve, and zero dependencies
means nothing to install on a machine with no internet. Would
reconsider only if replaying the whole log on boot became slow — it
doesn't, at the stated size.

**Transport: plain HTTP over localhost**, not child-process IPC or a
file-based queue. Chosen because it's inspectable with curl mid-demo,
and a reviewer can kill one process without disturbing another. Rejected
IPC because process supervision (Core spawning/owning worker processes)
was never in scope — workers are independent processes a human starts,
closer to how the real 40 services aren't owned by NEXUS either.

**Append-before-respond, everywhere.** The one rule that makes crash
recovery and normal startup the same code path: Core never tells a
caller "accepted" before that fact is on disk. This is the entire
mechanism behind R-01, and everything else (R-02 through R-05) is built
on top of it rather than alongside it.

**Worker heartbeats are deliberately not durable.** Unlike work items,
liveness is never written to the event log or replayed on boot. A
freshly restarted Core has no opinion about who's alive until heartbeats
resume — rejected persisting a "last known alive" because a stale value
surviving a restart would be actively misleading, not just incomplete.

**Release/rollback keeps one level of undo**, not a full version
history. Matches R-06's literal wording ("taken back in one action")
without building a feature Section 3.2 would want but the CORE
requirement doesn't ask for.

**Dedup lives entirely in Core**, not in a contract workers have to
honor. A duplicate completion report is recognized and ignored by Core
itself, regardless of whether the worker that sent it was written
carefully — because in the real system, 40 different teams wrote the
workers, and trusting all of them to cooperate was the root of the
incident this handbook is based on.

**Core lazily auto-starts one default worker on the first piece of work**
if nothing is currently heartbeating (`NEXUS_AUTO_WORKER=0` to disable).
This is a convenience, not process supervision: Core never restarts a
worker that dies later on its own — a later piece of work triggers a
fresh auto-start only because nothing is heartbeating at that moment,
which is the same rule a human restarting it by hand would trigger.
The distinction matters because "Core owns and supervises worker
processes" was deliberately out of scope (see the transport decision
above); this only ever starts one worker once, lazily, for convenience.

**What would change my mind:** if the size in the brief were "millions,"
not "a few thousand," the append-only file's O(n) replay-on-boot would
stop being free, and I'd reach for indexed storage. It isn't, so I didn't.

## Failure behaviour

| Failure | Handled? | What happens | How to trigger |
|---|---|---|---|
| Kill a worker mid-processing | Yes | Item stays visibly `dispatched`; not lost, not silently retried (Phase 04's automatic retry then takes over) | `kill-worker.cmd` while an item is in flight |
| Stop/restart platform holding work | Yes | Full state rebuilt from the event log on boot; identical to before the restart | Ctrl+C, then restart |
| Worker crashes every start | Yes | Retried with growing backoff, then `dead-lettered` after a stated attempt limit; reversible | `--crash-on-start` flag |
| Worker slow, not dead | Yes | Heartbeat (independent timer) keeps it `"alive"` throughout, regardless of task duration | `--delay=8000`, poll `/workers` |
| Same work delivered twice | Yes | First completion is authoritative; repeats are recorded as ignored duplicates, not reprocessed | `/debug/force-redeliver`, call `/work/:id/done` twice |
| Bad release, then rollback | Yes (light) | Worker behaviour actually changes with the release; one-action rollback with a known result, refuses if nothing to undo | `/release`, `/rollback` |
| Backlog grows unbounded | Yes | Rejected with HTTP 503 once a stated cap is hit — visible, not silent | `NEXUS_MAX_BACKLOG=2`, submit 3 |
| Large batch times out at once | Yes (stretch) | Recovery sweep caps itself per tick, draining over several seconds | `NEXUS_SWEEP_BATCH_LIMIT=3`, dispatch 12 to a dead worker id |
| Cached value disagrees with real value | No | Out of scope — no second copy of any fact exists in this model | — |
| Dependency taken away completely | No | Out of scope — no external dependency is modeled | — |

## Limits

- **Item-level retry timeouts don't consult worker heartbeat status.** A
  worker that is genuinely alive but slower than the retry timeout still
  triggers a redundant redelivery. Harmless today (the dedup ledger
  absorbs it, per Phase 03) but wasteful — found live during Phase 05
  testing, not fixed in scope. The fix is known: skip a redelivery when
  the current holder is still heartbeating.
- **No retention or rotation on the event log.** `/history` searches the
  entire file, always, with no stated cutoff. Honest at a few thousand
  items; would need an actual retention policy at real production scale.
- **No "watching period" for releases.** A release is either pushed or
  rolled back; nothing judges whether it's behaving before calling it
  final, and a quiet moment after a release is not treated as proof it's
  safe (nor claimed to be).
- **No graceful-shutdown handshake.** Durability was proven specifically
  via a hard kill (`kill-worker.cmd`, process-manager "end task"), the
  harder and more honest test — but there's also no clean drain-in-
  flight-then-exit path for an operator who wants one.
- **Single Core process, single machine, no clustering.** By design,
  matching Rule 01 — not a gap to grow past at this size.
- **"Component" restart budgets are per work item, not per worker
  process.** Core never spawns or supervises worker processes directly
  (they're independent, human-started processes, closer to the real
  system's 40 independently-owned services). What has a stated retry
  budget is the work, not the process running it.

## Confidence

**Tested live, by hand, for every phase**, with real commands and real
captured output at the time each piece was built: durability across a
hard `kill -9`-equivalent, duplicate completion producing exactly one
effect, the full retry → backoff → dead-letter → revive cycle, the
slow-vs-dead distinction under an actual 8-second task with heartbeats
polled mid-task, the backlog cap under real rejected requests, history
search by both work-item id and worker id, the full release → crash →
rollback → recovery cycle, and the sweep batch cap measured at an exact
1.7-second mark to catch a single tick in isolation. Two real code bugs
were caught this way (a wrong URL-splitting index on the redeliver
route; a log message reading a counter after it had already been
mutated) and fixed before being called done.

**Reasoned about, not exhaustively load-tested:** behaviour at the full
"few thousand items, ~10,000 backlog" scale named in the brief — actual
testing used tens of items, not thousands. The append-only-file design
has no algorithmic step that changes at that scale (no sort, no scan
that isn't already O(n) at any size), so this is a reasoned extrapolation,
not a demonstrated one.

**A real bug this exposed:** all four of the dashboard's action buttons
(Rollback, Kill, Revive, Force redeliver) built their `onclick` handler
as `onclick="fn(' + JSON.stringify(id) + ', this)"` - a double-quoted
HTML attribute containing a double-quoted JSON string. The inner quotes
closed the attribute early, silently truncating it to a broken JS
fragment; clicking did nothing, with no console error in most cases.
Every API endpoint behind these buttons was verified repeatedly by
calling it directly (curl/PowerShell), which never touches HTML
attribute parsing and so never could have caught this - the bug only
surfaced once a real click, in a real browser, on the real rendered
page was reported and traced back. Fixed by switching the outer
attribute to single quotes. The lesson generalized: API-level testing
proves the backend logic is right; it does not prove the button wired
to it actually works.

**Assumed, with a caveat:** the dashboard's visual rendering (colours,
layout, live-update behaviour as actually seen in a browser) was
confirmed by opening it in a real browser during the build, and its
underlying logic was traced by hand against real API responses — but no
automated screenshot or browser-testing tool was used, so treat the
visual polish as checked once, not regression-tested.

## Next

If another six hours were available, in this order:

1. Teach the retry sweep to skip redelivering an item whose current
   worker is still heartbeating — the exact gap found in Phase 05, and
   the cheapest fix relative to its value.
2. A real "watching period" for releases: judge behaviour for a stated
   window after a release, not just whether the process started, and
   treat "not sure yet" as a real answer at the end of it.
3. R-08 (disagreements are found): the event log already makes "two
   places claiming one fact" a natural extension to detect, since
   everything already flows through one timeline.
4. R-13 (order only claimed when known) and R-14 (ask the platform what
   it currently believes) for a genuinely complete Extended-tier answer.
