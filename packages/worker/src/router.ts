import {
  CarSchema,
  CheckRunSchema,
  PostedEventSchema,
  PrNumber,
  Sha,
  SoloInputSchema,
  TrainInputSchema,
} from "@joelhooks/piper/domain";
import { DEFAULT_CARS } from "@joelhooks/piper/policy";
import { failingOn, soloKey } from "@joelhooks/piper/solo";
import { Clock, Effect, Predicate, Schema } from "effect";

import { Auth } from "./auth.js";
import type { Settings } from "./bindings.js";
import { decode, json, readJson, refuse, stampedBody } from "./http.js";
import { readMetrics } from "./metrics.js";
import { forward } from "./transport.js";

const names = (value = "") =>
  value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

const responseBody = (response: Response) =>
  Effect.promise(response.json.bind(response));

const TrainOpening = Schema.Struct({
  ciTimeoutMs: Schema.optionalKey(TrainInputSchema.fields.ciTimeoutMs),
  maxCars: Schema.optionalKey(TrainInputSchema.fields.maxCars),
  pollMs: Schema.optionalKey(TrainInputSchema.fields.pollMs),
  train: Schema.optionalKey(PrNumber),
});

const SoloOpening = Schema.Struct({
  at: Schema.optionalKey(SoloInputSchema.fields.at),
  base: Sha,
  checks: Schema.Array(CheckRunSchema),
  ciTimeoutMs: Schema.optionalKey(SoloInputSchema.fields.ciTimeoutMs),
  head: Sha,
  owner: Schema.String,
  pollMs: Schema.optionalKey(SoloInputSchema.fields.pollMs),
  pr: PrNumber,
});

const TrainView = Schema.StructWithRest(
  Schema.Struct({
    alarmAt: Schema.optionalKey(Schema.Int),
    cars: Schema.Array(CarSchema),
    head: Schema.optionalKey(Schema.String),
    pr: Schema.optionalKey(PrNumber),
    state: Schema.String,
    status: Schema.String,
    train: PrNumber,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

const SoloView = Schema.Struct({
  alarmAt: Schema.optionalKey(Schema.Int),
  checks: Schema.Array(Schema.String),
  head: Sha,
  key: Schema.String,
  operator: Schema.Array(Schema.Struct({ action: Schema.String })),
  outcome: Schema.optionalKey(Schema.String),
  pr: PrNumber,
  state: Schema.String,
  status: Schema.String,
});

const trainSummary = (view: typeof TrainView.Type) => ({
  alarmAt: view.alarmAt,
  cars: view.cars.map((car) => car.number),
  head: view.head,
  pr: view.pr,
  state: view.state,
  status: view.status,
  train: view.train,
});

const soloSummary = (view: typeof SoloView.Type) => ({
  alarmAt: view.alarmAt,
  checks: view.checks,
  head: view.head,
  key: view.key,
  operator: view.operator.map((note) => note.action),
  outcome: view.outcome,
  pr: view.pr,
  state: view.state,
});

const openTrainCell = Effect.fn("Router.openTrain")(function* openTrainCell(
  request: Request,
  env: Settings
) {
  const body = yield* decode(TrainOpening)(yield* readJson(request));

  const input = yield* decode(TrainInputSchema)({
    ciTimeoutMs: body.ciTimeoutMs ?? 3_600_000,
    ignoredChecks: names(env.IGNORED_CHECKS),
    maxCars: body.maxCars ?? Number(env.MAX_CARS ?? DEFAULT_CARS),
    pollMs: body.pollMs ?? 90_000,
    repo: env.REPO ?? "repository",
    train: body.train ?? 1,
    trainLabel: env.TRAIN_LABEL ?? "train",
  });

  const allocated = yield* forward(
    "DEPOT",
    "depot",
    "/trains",
    "POST",
    JSON.stringify({ n: body.train })
  );

  if (!allocated.ok) {
    return allocated;
  }

  const { n } = yield* decode(Schema.Struct({ n: PrNumber }))(
    yield* responseBody(allocated)
  );

  return yield* forward(
    "TRAIN",
    `train-${n}`,
    "/open",
    "POST",
    JSON.stringify({ ...input, train: n })
  );
});

const openSoloCell = Effect.fn("Router.openSolo")(function* openSoloCell(
  env: Settings,
  opening: typeof SoloOpening.Type
) {
  const at = yield* Clock.currentTimeMillis;

  const input = yield* decode(SoloInputSchema)({
    ...opening,
    aggregateChecks: names(env.AGGREGATE_CHECKS),
    at: opening.at ?? at,
    ciTimeoutMs: opening.ciTimeoutMs ?? 3_600_000,
    ignoredChecks: names(env.IGNORED_CHECKS),
    pollMs: opening.pollMs ?? 90_000,
    repo: env.REPO ?? "repository",
  });

  const key = soloKey(input.pr, input.head);

  const opened = yield* forward(
    "SOLO",
    key,
    "/open",
    "POST",
    JSON.stringify(input)
  );

  if (opened.status === 201) {
    const registered = yield* forward(
      "DEPOT",
      "depot",
      "/solos",
      "POST",
      JSON.stringify({ head: input.head, pr: input.pr })
    );

    if (!registered.ok) {
      return registered;
    }
  }

  return opened;
});

const openCandidates = Effect.fn("Router.openCandidates")(
  function* openCandidates(env: Settings, request: Request) {
    const at = yield* Clock.currentTimeMillis;
    const body = yield* stampedBody(request, at);
    const batch = Array.isArray(body) ? body : [body];
    const events = yield* decode(Schema.Array(PostedEventSchema))(batch);

    for (const event of events) {
      if (!Predicate.isTagged(event, "candidates")) {
        continue;
      }

      for (const candidate of event.candidates) {
        const red = failingOn(
          candidate.headSha,
          candidate.checks,
          names(env.IGNORED_CHECKS)
        );

        const base = red.find((check) => check.baseSha !== undefined)?.baseSha;

        if (base !== undefined) {
          yield* openSoloCell(env, {
            at: event.at,
            base,
            checks: candidate.checks,
            head: candidate.headSha,
            owner: candidate.owner,
            pr: candidate.number,
          });
        }
      }
    }
  }
);

const trainViews = Effect.fn("Router.trainViews")(function* trainViews() {
  const response = yield* forward("DEPOT", "depot", "/trains");

  const entries = yield* decode(Schema.Array(Schema.Struct({ n: PrNumber })))(
    yield* responseBody(response)
  );

  const result: (typeof TrainView.Type)[] = [];

  for (const { n } of entries) {
    const cell = yield* forward("TRAIN", `train-${n}`, "/state");

    if (cell.ok) {
      result.push(yield* decode(TrainView)(yield* responseBody(cell)));
    }
  }

  return result;
});

const soloViews = Effect.fn("Router.soloViews")(function* soloViews() {
  const response = yield* forward("DEPOT", "depot", "/solos");

  const entries = yield* decode(
    Schema.Array(Schema.Struct({ key: Schema.String }))
  )(yield* responseBody(response));

  const result: (typeof SoloView.Type)[] = [];

  for (const { key } of entries) {
    const cell = yield* forward("SOLO", key, "/state");

    if (cell.ok) {
      result.push(yield* decode(SoloView)(yield* responseBody(cell)));
    }
  }

  return result;
});

const collectionRead = Effect.fn("Router.collectionRead")(
  function* collectionRead(path: string, env: Settings) {
    if (path === "/trains") {
      return json((yield* trainViews()).map(trainSummary));
    }

    if (path === "/solos") {
      return json((yield* soloViews()).map(soloSummary));
    }

    const trains = yield* trainViews();
    const solos = yield* soloViews();

    return json({
      current:
        trains.findLast((view) => view.status === "active") ?? trains.at(-1),
      repo: env.REPO ?? "repository",
      solos: solos.map(soloSummary),
      trains: trains.map(trainSummary),
      version: "0.1.0",
    });
  }
);

const cellRoute = Effect.fn("Router.cellRoute")(function* cellRoute(
  request: Request,
  env: Settings,
  parts: readonly string[]
) {
  const [kind, part] = parts;

  if ((kind !== "trains" && kind !== "solos") || part === undefined) {
    return refuse(404, "no-such-route");
  }

  const id = decodeURIComponent(part);

  if (kind === "trains" && !Schema.is(PrNumber)(Number(id))) {
    return refuse(404, "no-such-route");
  }

  const rest = parts.length === 2 ? "/state" : `/${parts.slice(2).join("/")}`;
  const copy = request.clone();

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : yield* Effect.promise(request.text.bind(request));

  const response = yield* forward(
    kind === "trains" ? "TRAIN" : "SOLO",
    kind === "trains" ? `train-${Number(id)}` : id,
    rest,
    request.method,
    body
  );

  if (
    kind === "trains" &&
    rest === "/events" &&
    request.method === "POST" &&
    response.ok
  ) {
    yield* openCandidates(env, copy);
  }

  return response;
});

const links = {
  metrics: "GET /metrics?since=<ms>",
  operator: "POST /solos/:key/operator",
  solo: "GET /solos/:key",
  soloEvents: "GET|POST /solos/:key/events",
  solos: "GET|POST /solos",
  state: "GET /state",
  train: "GET /trains/:n",
  trainEvents: "GET|POST /trains/:n/events",
  trains: "GET|POST /trains",
};

const route = Effect.fn("Router.route")(function* route(
  request: Request,
  env: Settings
) {
  const auth = yield* Auth;

  if (!(yield* auth.allowed(request))) {
    return refuse(401, "unauthorized");
  }

  const { pathname } = new URL(request.url);

  if (request.method === "GET") {
    if (pathname === "/") {
      return json({ links, name: "piper", version: "0.1.0" });
    }

    if (pathname === "/health") {
      return json({ ok: true, version: "0.1.0" });
    }

    if (pathname === "/metrics") {
      return yield* readMetrics(request);
    }

    if (["/trains", "/solos", "/state"].includes(pathname)) {
      return yield* collectionRead(pathname, env);
    }
  }

  if (request.method === "POST" && pathname === "/trains") {
    return yield* openTrainCell(request, env);
  }

  if (request.method === "POST" && pathname === "/solos") {
    return yield* openSoloCell(
      env,
      yield* decode(SoloOpening)(yield* readJson(request))
    );
  }

  return yield* cellRoute(request, env, pathname.split("/").filter(Boolean));
});

export const workerFetch = (request: Request, env: Settings) =>
  route(request, env).pipe(
    Effect.catchTag("BadRequest", () =>
      Effect.succeed(refuse(400, "bad-request"))
    )
  );
