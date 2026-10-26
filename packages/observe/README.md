# Observe release outcomes

The release-phase `readback` and `errors` checks share these terminal outcomes:

- `build-failed`: the newest deployment of the requested commit ended in `ERROR` or `CANCELED`. This build was not promoted. This outcome does not request a production rollback.
- `superseded`: the current READY production target is a different deployment, was created strictly after the requested deployment, and its commit contains the requested commit. Observe the newer release instead.

A superseded observation uses `by` for the superseding commit SHA and `deploymentId` for the superseding deployment ID. A build-failed observation keeps the failed deployment's ID, state and URL.

```json
{"deploymentId":"dpl_build","outcome":"build-failed","state":"CANCELED","url":"build.sample.test"}
{"by":"abcdef0123456789abcdef0123456789abcdef0123","deploymentId":"dpl_later","outcome":"superseded"}
```

`piper-observe` prints these observations through its existing JSON-line renderer. Existing observation fields and baseline/canary behavior remain unchanged.

## Commit ancestry port

`CommitContains` is an Effect context reference exported by the package. Its service is a function:

```ts
(ancestor: string, descendant: string) => Effect.Effect<Containment>;
```

`Containment` is `"yes" | "no" | "unknown"`. Only `yes` proves supersession. `no`, `unknown`, absent timestamps, absent commit metadata and unready targets leave the release unconfirmed, as before. The default reference and explicit `CommitContains.layer` both answer `unknown`.

Hosts can override the reference with `Layer.succeed(CommitContains, contains)` and provide that layer to `observe`. The implementation must return `unknown` for expected transport, authorization or comparison failures; defects remain defects. The host owns repository identity and ancestry credentials. There is no built-in GitHub adapter because the package's configuration has neither repository identity nor GitHub access settings.

Failed builds and proven supersession return before reading Axiom credentials or querying error windows. Serving releases still require the existing error-window checks. No polling or deadline policy changes are included.
