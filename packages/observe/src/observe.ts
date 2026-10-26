import { Clock, Data, Effect, Match, Option, pipe } from "effect";
import type { Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { CommitContains } from "./ancestry.js";
import { countRequests, iso } from "./axiom.js";
import type {
  Canary,
  CanaryFailure,
  CheckName,
  Observation,
  ObserveConfig,
  Phase,
  ReleaseOutcome,
} from "./domain.js";
import { optionalToken, requireToken } from "./http.js";
import {
  canaryMismatch,
  deploymentVerdict,
  errorsVerdict,
  errorWindows,
  isFailedBuild,
  isNewerDeployment,
  isSuperseded,
} from "./policy.js";
import { productionTarget, releaseDeployment, targetCommit } from "./vercel.js";
import type { Deployment } from "./vercel.js";

type Release = Data.TaggedEnum<{
  Absent: { readonly sha: string };
  Judged: {
    readonly deployment: Deployment;
    readonly outcome: "unknown";
  };
  Serving: { readonly deployment: Deployment; readonly readyAt: number };
  Terminal: { readonly observation: ReleaseOutcome };
}>;

const releases = Data.taggedEnum<Release>();

type Probe = Data.TaggedEnum<{
  Matched: { readonly url: string };
  Mismatched: CanaryFailure;
  Unreachable: { readonly url: string };
}>;

const probes = Data.taggedEnum<Probe>();

const unknown = (reason: string): Observation => ({
  outcome: "unknown",
  reason,
});

const inspectRelease = Effect.fn("Observe.inspectRelease")(
  function* inspectRelease(config: ObserveConfig, token: Redacted.Redacted) {
    const found = yield* releaseDeployment(config, token);

    if (Option.isNone(found)) {
      return releases.Absent({ sha: config.sha });
    }

    const deployment = found.value;

    if (isFailedBuild(deployment.readyState)) {
      return releases.Terminal({
        observation: {
          deploymentId: deployment.uid,
          outcome: "build-failed",
          state: deployment.readyState,
          url: deployment.url ?? "",
        },
      });
    }

    const target = yield* productionTarget(config, token);

    const serving = Option.exists(
      target,
      (current) => current.id === deployment.uid
    );

    if (Option.isSome(target) && target.value.readyState === "READY") {
      const current = target.value;
      const by = targetCommit(current);

      if (
        by !== undefined &&
        current.createdAt !== undefined &&
        isNewerDeployment(
          { created: deployment.created, id: deployment.uid },
          { created: current.createdAt, id: current.id }
        )
      ) {
        const contains = yield* CommitContains;
        const ancestry = yield* contains(config.sha, by);

        if (
          isSuperseded(
            { created: deployment.created, id: deployment.uid },
            { created: current.createdAt, id: current.id },
            ancestry
          )
        ) {
          return releases.Terminal({
            observation: {
              by,
              deploymentId: current.id,
              outcome: "superseded",
            },
          });
        }
      }
    }

    const verdict = deploymentVerdict(deployment.readyState, serving);

    return verdict === "pass" && deployment.ready !== undefined
      ? releases.Serving({ deployment, readyAt: deployment.ready })
      : releases.Judged({
          deployment,
          outcome: "unknown",
        });
  }
);

const readback = Effect.fn("Observe.readback")(function* readback(
  config: ObserveConfig,
  phase: Phase
) {
  const token = yield* requireToken("VERCEL_TOKEN");

  if (phase === "baseline") {
    return Option.match(yield* productionTarget(config, token), {
      onNone: () => unknown("the project has no production deployment"),
      onSome: (target): Observation => ({
        deploymentId: target.id,
        outcome: target.readyState === "READY" ? "pass" : "fail",
        state: target.readyState,
        url: target.url,
      }),
    });
  }

  return releases.$match(yield* inspectRelease(config, token), {
    Absent: ({ sha }) => unknown(`no production deployment of ${sha} yet`),
    Judged: ({ deployment, outcome }): Observation => ({
      deploymentId: deployment.uid,
      outcome,
      state: deployment.readyState,
      url: deployment.url ?? "",
    }),
    Serving: ({ deployment, readyAt }): Observation => ({
      deploymentId: deployment.uid,
      outcome: "pass",
      readyAt: iso(readyAt),
      url: deployment.url ?? "",
    }),
    Terminal: ({ observation }) => observation,
  });
});

const axiomAccess = Effect.gen(function* axiomAccess() {
  const token = yield* requireToken("AXIOM_TOKEN");
  const orgId = yield* optionalToken("AXIOM_ORG_ID");

  return { orgId, token };
});

const errors = Effect.fn("Observe.errors")(function* errors(
  config: ObserveConfig,
  phase: Phase
) {
  const length = config.axiom.windowMinutes * 60_000;

  if (phase === "baseline") {
    const access = yield* axiomAccess;
    const end = yield* Clock.currentTimeMillis;
    const span = { end, start: end - length };
    const before = yield* countRequests(config.axiom, access, span);

    return {
      before,
      outcome: "pass",
      window: { end: iso(span.end), start: iso(span.start) },
    } satisfies Observation;
  }

  const vercel = yield* requireToken("VERCEL_TOKEN");
  const release = yield* inspectRelease(config, vercel);

  if (releases.$is("Terminal")(release)) {
    return release.observation;
  }

  if (!releases.$is("Serving")(release)) {
    return unknown("the release is not serving production yet");
  }

  const access = yield* axiomAccess;
  const windows = errorWindows(release.readyAt, config.axiom.windowMinutes);

  if ((yield* Clock.currentTimeMillis) < windows.after.end) {
    return unknown(`the after window closes at ${iso(windows.after.end)}`);
  }

  const before = yield* countRequests(config.axiom, access, windows.before);
  const after = yield* countRequests(config.axiom, access, windows.after);

  return {
    after,
    before,
    outcome: errorsVerdict(config.axiom, before, after),
    window: {
      end: iso(windows.after.end),
      readyAt: iso(release.readyAt),
      start: iso(windows.before.start),
    },
  } satisfies Observation;
});

const probe = Effect.fn("Observe.probe")(function* probe(canary: Canary) {
  const client = yield* HttpClient.HttpClient;

  return yield* client.execute(HttpClientRequest.get(canary.url)).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((body) => canaryMismatch(canary, response.status, body))
      )
    ),
    Effect.match({
      onFailure: () => probes.Unreachable({ url: canary.url }),
      onSuccess: (reason) =>
        reason === undefined
          ? probes.Matched({ url: canary.url })
          : probes.Mismatched({ reason, url: canary.url }),
    })
  );
});

const canaries = Effect.fn("Observe.canaries")(function* canaries(
  config: ObserveConfig
) {
  const results = yield* pipe(
    config.canary,
    Effect.forEach((canary) => probe(canary))
  );

  const failures = results.filter((result) => probes.$is("Mismatched")(result));

  const unreachable = results.filter((result) =>
    probes.$is("Unreachable")(result)
  );

  if (failures.length > 0) {
    return {
      failures: failures.map(({ reason, url }) => ({ reason, url })),
      outcome: "fail",
    } satisfies Observation;
  }

  return unreachable.length > 0
    ? ({
        outcome: "unknown",
        unreachable: unreachable.map(({ url }) => url),
      } satisfies Observation)
    : ({ checked: results.length, outcome: "pass" } satisfies Observation);
});

export const observe = (
  config: ObserveConfig,
  check: CheckName,
  phase: Phase
): Effect.Effect<Observation, never, HttpClient.HttpClient> =>
  Match.value(check).pipe(
    Match.when("readback", () => readback(config, phase)),
    Match.when("errors", () => errors(config, phase)),
    Match.when("canary", () => canaries(config)),
    Match.exhaustive,
    Effect.catchTag("ObserveError", ({ reason }) =>
      Effect.succeed(unknown(reason))
    )
  );

export const render = (observation: Observation) => JSON.stringify(observation);
