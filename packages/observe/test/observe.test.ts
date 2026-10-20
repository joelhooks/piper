import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";

import { iso } from "../src/axiom.js";
import { decodeConfig } from "../src/config.js";
import type { TokenName } from "../src/http.js";
import { observe, render } from "../src/observe.js";
import {
  config,
  environment,
  fakeHttp,
  json,
  offline,
  sha,
  text,
  tokens,
} from "./fake.js";
import type { Reply, Sent } from "./fake.js";

const readyAt = 1_800_000_000_000;

const windowMs = 15 * 60_000;

const building = (
  readyState: string,
  uid = "dpl_new",
  created = readyAt - 60_000
) => ({
  created,
  createdAt: created,
  creator: { uid: "synthetic-user" },
  inspectorUrl: null,
  meta: { githubCommitSha: sha },
  name: "sample",
  projectId: "prj_synthetic",
  readyState,
  type: "LAMBDAS",
  uid,
  url: `${uid}.sample.test`,
});

const deployment = (
  readyState: string,
  uid = "dpl_new",
  created = readyAt - 60_000
) =>
  readyState === "READY"
    ? { ...building(readyState, uid, created), ready: readyAt }
    : building(readyState, uid, created);

const serving = (uid: string, readyState = "READY") => ({
  createdAt: readyAt - 60_000,
  id: uid,
  readyState,
  url: `${uid}.sample.test`,
});

const project = (production?: ReturnType<typeof serving>) => ({
  id: "prj_synthetic",
  name: "sample",
  targets: production === undefined ? {} : { production },
});

const listed = (...deployments: readonly ReturnType<typeof deployment>[]) => ({
  deployments,
  pagination: { count: deployments.length, next: null, prev: null },
});

const counts = (requests: number, errors: number, isPartial = false) => ({
  datasetNames: ["synthetic-logs"],
  format: "tabular",
  status: { isPartial, rowsExamined: requests, rowsMatched: requests },
  tables: [
    {
      columns: [[requests], [errors]],
      fields: [
        { name: "requests", type: "integer" },
        { name: "errors", type: "integer" },
      ],
      name: "0",
    },
  ],
});

interface Scene {
  readonly deployments?: Reply;
  readonly project?: Reply;
  readonly before?: Reply;
  readonly after?: Reply;
  readonly pages?: Readonly<Record<string, Reply>>;
}

const spanOf = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ endTime: Schema.String, startTime: Schema.String })
  )
);

const route =
  (scene: Scene) =>
  (request: Sent): Reply => {
    if (request.url.pathname === "/v7/deployments") {
      return scene.deployments ?? json(listed());
    }

    if (request.url.pathname === "/v9/projects/prj_synthetic") {
      return scene.project ?? json(project());
    }

    if (request.url.pathname === "/v1/datasets/_apl") {
      const after = iso(readyAt);

      return spanOf(request.body).startTime === after
        ? (scene.after ?? json(counts(0, 0)))
        : (scene.before ?? json(counts(0, 0)));
    }

    return scene.pages?.[request.url.toString()] ?? text("missing", 404);
  };

const run = (
  scene: Scene,
  check: "readback" | "errors" | "canary",
  phase: "baseline" | "release" = "release",
  values: Readonly<Record<string, string>> = tokens
) =>
  Effect.gen(function* runScene() {
    const sent: Sent[] = [];

    const observation = yield* observe(config, check, phase).pipe(
      Effect.provide(
        Layer.mergeAll(fakeHttp(sent, route(scene)), environment(values))
      )
    );

    return { observation, sent };
  });

const releasedScene: Scene = {
  deployments: json(listed(deployment("READY"))),
  project: json(project(serving("dpl_new"))),
};

const afterWindow = TestClock.setTime(readyAt + windowMs + 1);

describe("config", () => {
  it.effect("decodes the documented config", () =>
    Effect.gen(function* test() {
      const decoded = yield* decodeConfig(JSON.stringify(config));

      expect(decoded).toEqual(config);
    })
  );

  it.effect("names a missing field", () =>
    Effect.gen(function* test() {
      const { dataset: _dataset, ...axiom } = config.axiom;

      const exit = yield* Effect.exit(
        decodeConfig(JSON.stringify({ ...config, axiom }))
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("dataset");
    })
  );

  it.effect("names an unknown field", () =>
    Effect.gen(function* test() {
      const exit = yield* Effect.exit(
        decodeConfig(
          JSON.stringify({
            ...config,
            vercel: { ...config.vercel, surprise: true },
          })
        )
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("surprise");
    })
  );

  it.effect("rejects a short sha and malformed JSON", () =>
    Effect.gen(function* test() {
      const short = yield* Effect.exit(
        decodeConfig(JSON.stringify({ ...config, sha: "abc123" }))
      );

      const broken = yield* Effect.exit(decodeConfig("{"));

      expect(Exit.isFailure(short)).toBe(true);
      expect(JSON.stringify(short)).toContain("sha");
      expect(Exit.isFailure(broken)).toBe(true);
    })
  );
});

describe("readback", () => {
  it.effect("passes when the sha is READY and serving production", () =>
    Effect.gen(function* test() {
      const { observation, sent } = yield* run(releasedScene, "readback");

      expect(observation).toEqual({
        deploymentId: "dpl_new",
        outcome: "pass",
        readyAt: iso(readyAt),
        url: "dpl_new.sample.test",
      });

      const [list] = sent;

      expect(list?.url.searchParams.get("projectId")).toBe("prj_synthetic");
      expect(list?.url.searchParams.get("teamId")).toBe("team_synthetic");
      expect(list?.url.searchParams.get("target")).toBe("production");
      expect(list?.url.searchParams.get("sha")).toBe(sha);
      expect(list?.headers.authorization).toBe(`Bearer ${tokens.VERCEL_TOKEN}`);
      expect(render(observation)).not.toContain(tokens.VERCEL_TOKEN);
    })
  );

  it.effect("judges only the newest deployment of the sha", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        {
          deployments: json(
            listed(
              deployment("ERROR", "dpl_old", readyAt - 120_000),
              deployment("READY")
            )
          ),
          project: json(project(serving("dpl_new"))),
        },
        "readback"
      );

      expect(observation.outcome).toBe("pass");
    })
  );

  it.effect.each(["BUILDING", "QUEUED", "INITIALIZING"])(
    "is unknown while %s",
    (state) =>
      Effect.gen(function* test() {
        const { observation } = yield* run(
          { deployments: json(listed(deployment(state))) },
          "readback"
        );

        expect(observation.outcome).toBe("unknown");
      })
  );

  it.effect("is unknown until a deployment of the sha exists", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run({}, "readback");

      expect(observation.outcome).toBe("unknown");
    })
  );

  it.effect("ignores a listed deployment of another sha", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        {
          deployments: json(
            listed({ ...deployment("READY"), meta: { githubCommitSha: "f00" } })
          ),
          project: json(project(serving("dpl_new"))),
        },
        "readback"
      );

      expect(observation.outcome).toBe("unknown");
    })
  );

  it.effect("is unknown while READY but not yet serving production", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        {
          deployments: json(listed(deployment("READY"))),
          project: json(project(serving("dpl_previous"))),
        },
        "readback"
      );

      expect(observation.outcome).toBe("unknown");
    })
  );

  it.effect.each(["ERROR", "CANCELED"])("fails on %s", (state) =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        { deployments: json(listed(deployment(state))) },
        "readback"
      );

      expect(observation).toMatchObject({
        deploymentId: "dpl_new",
        outcome: "fail",
        state,
      });
    })
  );

  it.effect("is unknown with a reason when VERCEL_TOKEN is missing", () =>
    Effect.gen(function* test() {
      const { observation, sent } = yield* run(
        releasedScene,
        "readback",
        "release",
        { AXIOM_ORG_ID: "o", AXIOM_TOKEN: "t" }
      );

      expect(observation).toEqual({
        outcome: "unknown",
        reason: "missing VERCEL_TOKEN",
      });
      expect(sent).toHaveLength(0);
    })
  );

  it.effect("is unknown when Vercel answers with an error status", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        { deployments: json({ error: { code: "forbidden" } }, 403) },
        "readback"
      );

      expect(observation).toMatchObject({ outcome: "unknown" });
      expect(render(observation)).toContain("403");
    })
  );

  it.effect("is unknown when Vercel answers with an unexpected shape", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        { deployments: json({ items: [] }) },
        "readback"
      );

      expect(observation.outcome).toBe("unknown");
    })
  );

  it.effect("baseline passes when current production is READY", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        { project: json(project(serving("dpl_previous"))) },
        "readback",
        "baseline"
      );

      expect(observation).toMatchObject({
        deploymentId: "dpl_previous",
        outcome: "pass",
      });
    })
  );

  it.effect("baseline fails when current production is not READY", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        { project: json(project(serving("dpl_previous", "ERROR"))) },
        "readback",
        "baseline"
      );

      expect(observation.outcome).toBe("fail");
    })
  );

  it.effect("baseline is unknown without a production deployment", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run({}, "readback", "baseline");

      expect(observation.outcome).toBe("unknown");
    })
  );
});

describe("errors", () => {
  it.effect("passes when the after rate stays within the ratio", () =>
    Effect.gen(function* test() {
      yield* afterWindow;

      const { observation, sent } = yield* run(
        {
          ...releasedScene,
          after: json(counts(4000, 6)),
          before: json(counts(4000, 4)),
        },
        "errors"
      );

      expect(observation).toEqual({
        after: { errors: 6, requests: 4000 },
        before: { errors: 4, requests: 4000 },
        outcome: "pass",
        window: {
          end: iso(readyAt + windowMs),
          readyAt: iso(readyAt),
          start: iso(readyAt - windowMs),
        },
      });

      const queries = sent.filter(
        (request) => request.url.pathname === "/v1/datasets/_apl"
      );

      expect(queries).toHaveLength(2);

      for (const query of queries) {
        expect(query.method).toBe("POST");
        expect(query.url.host).toBe("api.axiom.co");
        expect(query.url.searchParams.get("format")).toBe("tabular");
        expect(query.headers.authorization).toBe(
          `Bearer ${tokens.AXIOM_TOKEN}`
        );
        expect(query.headers["x-axiom-org-id"]).toBe(tokens.AXIOM_ORG_ID);
        expect(query.body).toContain("['synthetic-logs']");
        expect(query.body).toContain(config.axiom.filter);
        expect(query.body).toContain("['request.statusCode']) >= 500");
      }

      expect(queries.map((query) => spanOf(query.body))).toEqual([
        { endTime: iso(readyAt), startTime: iso(readyAt - windowMs) },
        { endTime: iso(readyAt + windowMs), startTime: iso(readyAt) },
      ]);
    })
  );

  it.effect("breaches when the after rate exceeds the ratio and floor", () =>
    Effect.gen(function* test() {
      yield* afterWindow;

      const { observation } = yield* run(
        {
          ...releasedScene,
          after: json(counts(4000, 40)),
          before: json(counts(4000, 4)),
        },
        "errors"
      );

      expect(observation).toMatchObject({
        after: { errors: 40, requests: 4000 },
        outcome: "breach",
      });
    })
  );

  it.effect("breaches against an error-free before window", () =>
    Effect.gen(function* test() {
      yield* afterWindow;

      const { observation } = yield* run(
        {
          ...releasedScene,
          after: json(counts(1000, 2)),
          before: json(counts(0, 0)),
        },
        "errors"
      );

      expect(observation.outcome).toBe("breach");
    })
  );

  it.effect("passes when after errors stay at the hard floor", () =>
    Effect.gen(function* test() {
      yield* afterWindow;

      const { observation } = yield* run(
        {
          ...releasedScene,
          after: json(counts(1000, 1)),
          before: json(counts(1000, 0)),
        },
        "errors"
      );

      expect(observation.outcome).toBe("pass");
    })
  );

  it.effect("is unknown until the after window has elapsed", () =>
    Effect.gen(function* test() {
      yield* TestClock.setTime(readyAt + windowMs - 1);

      const { observation, sent } = yield* run(releasedScene, "errors");

      expect(observation.outcome).toBe("unknown");
      expect(
        sent.some((request) => request.url.pathname === "/v1/datasets/_apl")
      ).toBe(false);
    })
  );

  it.effect("is unknown below the minimum after requests", () =>
    Effect.gen(function* test() {
      yield* afterWindow;

      const { observation } = yield* run(
        {
          ...releasedScene,
          after: json(counts(999, 999)),
          before: json(counts(4000, 0)),
        },
        "errors"
      );

      expect(observation).toMatchObject({
        after: { errors: 999, requests: 999 },
        outcome: "unknown",
      });
    })
  );

  it.effect("is unknown on a partial Axiom result", () =>
    Effect.gen(function* test() {
      yield* afterWindow;

      const { observation } = yield* run(
        {
          ...releasedScene,
          after: json(counts(4000, 400, true)),
          before: json(counts(4000, 0)),
        },
        "errors"
      );

      expect(observation.outcome).toBe("unknown");
    })
  );

  it.effect("is unknown while the release is not serving yet", () =>
    Effect.gen(function* test() {
      yield* afterWindow;

      const { observation } = yield* run(
        { deployments: json(listed(deployment("BUILDING"))) },
        "errors"
      );

      expect(observation.outcome).toBe("unknown");
    })
  );

  it.effect.each<TokenName>(["AXIOM_TOKEN", "VERCEL_TOKEN"])(
    "is unknown with a reason when %s is missing",
    (name) =>
      Effect.gen(function* test() {
        yield* afterWindow;

        const { [name]: _missing, ...values } = tokens;

        const { observation } = yield* run(
          releasedScene,
          "errors",
          "release",
          values
        );

        expect(observation).toEqual({
          outcome: "unknown",
          reason: `missing ${name}`,
        });
      })
  );

  it.effect("queries without the org header when AXIOM_ORG_ID is unset", () =>
    Effect.gen(function* test() {
      yield* afterWindow;

      const { AXIOM_ORG_ID: _org, ...values } = tokens;

      const { observation, sent } = yield* run(
        {
          ...releasedScene,
          after: json(counts(4000, 6)),
          before: json(counts(4000, 4)),
        },
        "errors",
        "release",
        values
      );

      const queries = sent.filter(
        (request) => request.url.pathname === "/v1/datasets/_apl"
      );

      expect(observation.outcome).toBe("pass");
      expect(queries).toHaveLength(2);
      expect(queries.some((query) => "x-axiom-org-id" in query.headers)).toBe(
        false
      );
    })
  );

  it.effect("is unknown when Axiom refuses the query", () =>
    Effect.gen(function* test() {
      yield* afterWindow;

      const { observation } = yield* run(
        { ...releasedScene, after: json({ message: "forbidden" }, 403) },
        "errors"
      );

      expect(observation.outcome).toBe("unknown");
      expect(render(observation)).not.toContain(tokens.AXIOM_TOKEN);
    })
  );

  it.effect("baseline passes when the before window query succeeds", () =>
    Effect.gen(function* test() {
      yield* TestClock.setTime(readyAt);

      const { observation, sent } = yield* run(
        { before: json(counts(3000, 2)) },
        "errors",
        "baseline",
        { AXIOM_ORG_ID: tokens.AXIOM_ORG_ID, AXIOM_TOKEN: tokens.AXIOM_TOKEN }
      );

      expect(observation).toMatchObject({
        before: { errors: 2, requests: 3000 },
        outcome: "pass",
      });
      expect(sent.map((request) => spanOf(request.body))).toEqual([
        { endTime: iso(readyAt), startTime: iso(readyAt - windowMs) },
      ]);
    })
  );

  it.effect("baseline is unknown when the before window query fails", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        { before: offline },
        "errors",
        "baseline"
      );

      expect(observation.outcome).toBe("unknown");
    })
  );
});

describe("canary", () => {
  const healthy = {
    "https://sample.test/": text("<h1>Welcome</h1>"),
    "https://sample.test/health": text("ok"),
  };

  it.effect("passes when every page matches, sending no cookies", () =>
    Effect.gen(function* test() {
      const { observation, sent } = yield* run(
        { pages: healthy },
        "canary",
        "release",
        {}
      );

      expect(observation).toEqual({ checked: 2, outcome: "pass" });
      expect(sent.map((request) => request.method)).toEqual(["GET", "GET"]);
      expect(sent.every((request) => !("cookie" in request.headers))).toBe(
        true
      );
    })
  );

  it.effect("fails naming the URL on a status mismatch", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        {
          pages: {
            ...healthy,
            "https://sample.test/health": text("ok", 503),
          },
        },
        "canary"
      );

      expect(observation).toEqual({
        failures: [
          {
            reason: "expected status 200, got 503",
            url: "https://sample.test/health",
          },
        ],
        outcome: "fail",
      });
    })
  );

  it.effect("fails naming the URL when the body lacks the text", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        {
          pages: { ...healthy, "https://sample.test/": text("<h1>Oops</h1>") },
        },
        "canary"
      );

      expect(observation).toMatchObject({
        failures: [{ url: "https://sample.test/" }],
        outcome: "fail",
      });
    })
  );

  it.effect("is unknown on a network error", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        { pages: { ...healthy, "https://sample.test/health": offline } },
        "canary"
      );

      expect(observation).toMatchObject({
        outcome: "unknown",
        unreachable: ["https://sample.test/health"],
      });
    })
  );

  it.effect("baseline runs the same checks against current production", () =>
    Effect.gen(function* test() {
      const { observation } = yield* run(
        { pages: healthy },
        "canary",
        "baseline"
      );

      expect(observation.outcome).toBe("pass");
    })
  );
});

describe("render", () => {
  it("prints one JSON line", () => {
    expect(render({ outcome: "unknown", reason: "missing VERCEL_TOKEN" })).toBe(
      '{"outcome":"unknown","reason":"missing VERCEL_TOKEN"}'
    );
  });
});
