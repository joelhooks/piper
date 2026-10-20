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

`baseBranch` is required. There is no default or fallback. `input` follows core's `TrainInputSchema`, including its optional candidate-check policy. Its repo and train must match the top-level admission. The admitted car is exactly one PR number and reviewed head.

`tokenCommand` is trusted operator configuration. The runner executes it through `sh -c` when a GitHub request needs a token. Only stdout supplies the token. Empty output and nonzero exits fail closed. Do not put token values in admission files. Command stderr, command text and token output are not copied into failure records.

Live mode requires `PIPER_LIVE_ADMITTED_REPO` to equal `repo` exactly. Refusal happens before token execution or provider reads. Dry-run still reads GitHub, but uses a writer that dies on use. It records the proposed build and exits before PR creation or any later intent.

## Lifecycle and stops

The runner machine uses `setupEffect` and starts through `createEffectActor`. Preparation checks admission and saved state. `polling` observes the base, car and train. `draining` executes one unseen intent at a time. Final states are `landed`, `stopped` and `rehearsed`. Flags, seen IDs and the conservative write count belong to machine context. One `Schedule.spaced` supplies the poll interval; draining has no clock.

Allowed intents are `BuildTrain`, `OpenTrainPr`, `PollChecks`, `MarkReady`, `Merge`, `RemoveLabels` and `RerunChecks`. A build must target `train/<train>` and contain exactly the admitted car and head. Other intents stop this train.

A rerun requires a fresh GitHub observation of at least one finished, non-green, non-ignored check on the train head. Every such failure must be `cancelled`, `startup_failure` or `stale`. The fresh read matters: core clears its checks when emitting a rerun intent.

Every refusal is a `TrainStopSchema` variant with required `harm`, `next`, `stop` and `detail`. Moved heads need a new admission. A moved base needs a new train. Missing, failing and pending boarding checks produce different next actions. Failed executor outcomes preserve `detail.code` and `detail.message`. Expected failures become a stopped result; defects remain defects.

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
| Poll | `at`, `cars`, `head`, `pr`, `state` |
| Intent | `at`, `intent` (kind), `id`, `mode` |
| Outcome | `at`, `done` (kind), `events`, `status` |
| Rerun | `at`, `rerun: true`, `faults`, `head` |
| Stop | `at`, `stop`, `detail`, `head`, `pr`, `state`, `writes`, `harm`, `next` |
| Exit | `exit` (reason string) |

`at` is an ISO timestamp except inside executor events, where it remains milliseconds. Undefined `cars`, `head`, `pr` and `runId` fields are omitted by JSON. `events` use core's posted train-event union. Rerun faults contain `conclusion`, `name` and optional `runId`. `harm` and `next` are additions to stop records; existing fields keep their names. Successful trains emit an exit record without a refusal record.

## Test evidence

The runner has 37 tests, including a generated rerun-safety property. [The sanitized mutation receipt](../../docs/train-runner-proof.json) records each case failing under planted runtime faults, then passing after restoration. The faults ran in combined sweeps; this is a red/green sensitivity check, not an exhaustive mutation score. All fixtures are synthetic.

## Library

Import `decodeTrainAdmission` and `runTrain` from `@joelhooks/piper-executor`. Decode unknown input at the boundary. A decode failure is a typed `TrainStop`; pass it to `runTrain` to emit compatible stop and exit records without starting work. `runTrain` returns `{ exit, stop, success, writes }`.

Supply GitHub, writes, recorder, judge, store and sink services. The CLI provides the file and console layers. The runner does not own a deployed service, scheduler or production admission.
