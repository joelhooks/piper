# One admitted train

`piper-executor train <admission.json> <state-dir>` runs one train through the public train host and executor. It exits 0 for `landed` or `rehearsal complete`, otherwise 1. It does not start another train after a refusal.

The runner is separate from the Worker-outbox executor. It posts head-bound GO using the admission's `goBy`. This is explicit operator authorization, not acceptance inferred from CI. It never emits plan acceptance or landed-credit facts.

## Admission

The JSON must decode as `TrainAdmissionSchema` from `@joelhooks/piper-executor/train-domain`:

```json
{
  "baseBranch": "trunk",
  "car": { "headSha": "reviewed-car-head", "number": 1 },
  "goBy": "operator",
  "input": {
    "candidateRequiredChecks": [["unit"]],
    "ciTimeoutMs": 1800000,
    "ignoredChecks": [],
    "maxCars": 1,
    "pollMs": 60000,
    "repo": "sample/project",
    "train": 1,
    "trainLabel": "queue"
  },
  "mode": "dry-run",
  "repo": "sample/project",
  "tokenCommand": "your-token-command",
  "train": 1
}
```

`baseBranch` is required. There is no default or fallback. `input.pollMs` sets the riding poll interval: at least 10 seconds and at most 2 minutes. `input` follows core's `TrainInputSchema`, including its optional candidate-check policy. Its repo and train must match the top-level admission. The admitted car is exactly one PR number and reviewed head.

The admitted car is alone in its candidate pool, so it boards on push: absent and pending checks do not hold it, and only a completed, failed, non-ignored check on its head refuses it. Set `input.directRequiredChecks` to let it land without a train. That happens when its head contains the base, its own checks are complete and green, and every check in every listed group succeeded.

`tokenCommand` is trusted operator configuration. The runner executes it through `sh -c` when a GitHub request needs a token. Only stdout supplies the token. Empty output and nonzero exits fail closed. Do not put token values in admission files. Command stderr, command text and token output are not copied into failure records.

Live mode requires `PIPER_LIVE_ADMITTED_REPO` to equal `repo` exactly. Refusal happens before token execution or provider reads. Dry-run still reads GitHub, but uses a writer that dies on use. It records the proposed build, or the proposed direct merge and the ready-mark a draft car needs before it, and exits before any later intent.

## Lifecycle and stops

The runner machine uses `setupEffect` and starts through `createEffectActor`. Preparation checks admission and saved state. `boarding.polling` posts candidates and departs once. A direct departure already has a head, so the runner posts head-bound GO for the admitted head in the same poll and moves straight to `riding.draining`. `boarding.draining` executes unseen intents until a successful `BuildTrain` moves it into `riding.draining`. An empty boarding drain stops with `car not boarded`. `riding.polling` posts tick and head-bound GO, then `riding.draining` executes one unseen intent per invocation. An empty riding drain ends `landed` once the core train has landed, otherwise it returns to polling. Final states are `landed`, `stopped` and `rehearsed`.

The graph carries departure, build and drain progress. Context holds admission, the persisted core train, seen IDs, the conservative write count and any refusal. It has no lifecycle flags. Observations carry the drained intent kind and restored core snapshot into explicit transitions. One `Schedule.spaced` supplies the riding poll interval; boarding and draining have no clock.

Allowed intents are `BuildTrain`, `OpenTrainPr`, `PollChecks`, `MarkReady`, `Merge`, `RemoveLabels` and `RerunChecks`. A build must target `train/<train>` and contain exactly the admitted car and head. A merge of the admitted car's own pull request must match its reviewed head. Other intents stop this train. Both landings mark the pull request ready for review right before its merge, because GitHub refuses to merge a draft. `MarkReady` writes only when the pull request is still a draft.

A rerun requires a fresh GitHub observation of at least one finished, non-green, non-ignored check on the train head. Every such failure must be `cancelled`, `startup_failure` or `stale`. The fresh read matters: core clears its checks when emitting a rerun intent.

Every refusal is a `TrainStopSchema` variant with required `harm`, `next`, `stop` and `detail`. Moved heads need a new admission. A moved base needs a new train. Missing, failing and pending boarding checks produce different next actions. Failed executor outcomes preserve `detail.code` and `detail.message`. A failed ready-mark stops as `ReadyFailed` before any merge and names the pull request to mark ready by hand. Expected failures become a stopped result; defects remain defects.

## State and handback

`TrainStore.file(stateDir)` owns `state.json` and `log.jsonl`. `RecordSink.console` owns stdout. Both have in-memory test layers. These services are exported separately from the lifecycle.

The store takes an exclusive `runner.lock`. A concurrent writer cannot remove the holder's lock. A stale lock needs an operator to verify the previous process has stopped before removing only that lock.

State contains `{ train, seen, writes }`. `train` is core's persisted actor snapshot, restored through the train host. Saves write a private `state.next`, fsync it, rename it over `state.json` and fsync the parent directory. State mode is 0600. Log records are appended and fsynced before stdout receives the same line.

The runner persists an intent's seen ID before execution. Each live write-capable intent increments `writes` before execution, even if the provider later refuses it. `PollChecks` and dry-run do not increment it. This count records possible write intents, not individual HTTP requests. It deliberately errs toward handback after an ambiguous operation.

A saved dry-run build can be rehearsed again. Its build proposal becomes unseen on restart, because no provider write or completion event occurred. Other seen IDs stay intact. This avoids waiting forever for a build that dry-run deliberately never creates.

An existing state with `writes > 0` always refuses automatic resumption: harm `double writes`, next `hand back; the owner decides`. Preserve state and log. Do not clear the count or reuse the directory to bypass the refusal. Rollback means stopping the runner and handing back its state, not replaying writes.

## JSON line contract

`TrainRecord` is the Schema for stdout and `log.jsonl`. It preserves the existing queue consumer fields:

| Kind | Fields |
| --- | --- |
| Start | `at`, `start` (train number), `car`, `mode`, `repo` |
| Departure | `at`, `path` (`direct-land`, `lone-board` or `train`), `reason`, `cars`, `base` |
| Poll | `at`, `cars`, `head`, `pr`, `state` |
| Intent | `at`, `intent` (kind), `id`, `mode` |
| Outcome | `at`, `done` (kind), `events`, `status` |
| Rerun | `at`, `rerun: true`, `faults`, `head` |
| Stop | `at`, `stop`, `detail`, `head`, `pr`, `state`, `writes`, `harm`, `next` |
| Exit | `exit` (reason string) |

`at` is an ISO timestamp except inside executor events, where it remains milliseconds. Undefined `cars`, `head`, `pr` and `runId` fields are omitted by JSON. `events` use core's posted train-event union. Rerun faults contain `conclusion`, `name` and optional `runId`. `harm` and `next` are additions to stop records; existing fields keep their names. A departure record names the path the core train chose and why. A `car not boarded` stop names the boarding path in `detail.path`. A direct landing has no `BuildTrain` or `OpenTrainPr` records; its `MarkReady` and `Merge` target the car's own pull request. Successful trains emit an exit record without a refusal record.

## Test evidence

The runner has 46 tests, including a generated rerun-safety property. A live actor trace asserts every reachable leaf state across landed, rehearsed, refused and direct runs. A failed dry build must stop rather than enter the rehearsal final state. All fixtures are synthetic. Mutation receipts belong to the delivery packet, not the public source tree.

## Library

Import `decodeTrainAdmission` and `runTrain` from `@joelhooks/piper-executor`. Decode unknown input at the boundary. A decode failure is a typed `TrainStop`; pass it to `runTrain` to emit compatible stop and exit records without starting work. `runTrain` returns `{ exit, stop, success, writes }`.

Supply GitHub, writes, recorder, judge, store and sink services. The CLI provides the file and console layers. The runner does not own a deployed service, scheduler or production admission.
