import { Array, Effect, Option, Order, Schema } from "effect";
import type { Redacted } from "effect";
import { HttpClientRequest } from "effect/http";

import type { ObserveConfig } from "./domain.js";
import { fetchJson } from "./http.js";

const ReadyState = Schema.Literals([
  "BLOCKED",
  "BUILDING",
  "CANCELED",
  "DELETED",
  "ERROR",
  "INITIALIZING",
  "QUEUED",
  "READY",
]);

const GitMetaSchema = Schema.Struct({
  bitbucketCommitSha: Schema.optionalKey(Schema.String),
  githubCommitSha: Schema.optionalKey(Schema.String),
  gitlabCommitSha: Schema.optionalKey(Schema.String),
});

const DeploymentSchema = Schema.Struct({
  created: Schema.Finite,
  meta: Schema.optionalKey(GitMetaSchema),
  ready: Schema.optionalKey(Schema.Finite),
  readyState: ReadyState,
  uid: Schema.String,
  url: Schema.NullOr(Schema.String),
});

export type Deployment = typeof DeploymentSchema.Type;

const DeploymentsSchema = Schema.Struct({
  deployments: Schema.Array(DeploymentSchema),
});

const TargetSchema = Schema.Struct({
  createdAt: Schema.optionalKey(Schema.Finite),
  id: Schema.String,
  meta: Schema.optionalKey(GitMetaSchema),
  readyState: ReadyState,
  url: Schema.String,
});

export type Target = typeof TargetSchema.Type;

const ProjectSchema = Schema.Struct({
  targets: Schema.optionalKey(
    Schema.Struct({
      production: Schema.optionalKey(Schema.NullOr(TargetSchema)),
    })
  ),
});

const vercelGet = (
  token: Redacted.Redacted,
  path: string,
  params: Readonly<Record<string, string>>
) =>
  HttpClientRequest.get(`https://api.vercel.com${path}`).pipe(
    HttpClientRequest.setUrlParams(params),
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.acceptJson
  );

export const targetCommit = (target: Target) =>
  target.meta?.githubCommitSha ??
  target.meta?.gitlabCommitSha ??
  target.meta?.bitbucketCommitSha;

const builtFrom = (deployment: Deployment, sha: string) =>
  [
    deployment.meta?.githubCommitSha,
    deployment.meta?.gitlabCommitSha,
    deployment.meta?.bitbucketCommitSha,
  ].includes(sha);

const newestFirst = Order.flip(
  Order.mapInput(Order.Number, (deployment: Deployment) => deployment.created)
);

export const releaseDeployment = Effect.fn("Observe.releaseDeployment")(
  function* releaseDeployment(config: ObserveConfig, token: Redacted.Redacted) {
    const { deployments } = yield* fetchJson(
      "Vercel",
      vercelGet(token, "/v7/deployments", {
        limit: "20",
        projectId: config.vercel.projectId,
        sha: config.sha,
        target: "production",
        teamId: config.vercel.teamId,
      }),
      DeploymentsSchema
    );

    return Array.head(
      Array.sort(
        deployments.filter((deployment) => builtFrom(deployment, config.sha)),
        newestFirst
      )
    );
  }
);

export const productionTarget = Effect.fn("Observe.productionTarget")(
  function* productionTarget(config: ObserveConfig, token: Redacted.Redacted) {
    const project = yield* fetchJson(
      "Vercel",
      vercelGet(
        token,
        `/v9/projects/${encodeURIComponent(config.vercel.projectId)}`,
        {
          teamId: config.vercel.teamId,
        }
      ),
      ProjectSchema
    );

    return Option.fromNullishOr(project.targets?.production);
  }
);
