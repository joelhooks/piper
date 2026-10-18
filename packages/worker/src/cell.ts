import {
  PostedEventSchema,
  PostedSoloEventSchema,
  SoloInputSchema,
  TrainInputSchema,
  TrainEvents,
  toSoloEvent,
  toTrainEvent,
} from "@joelhooks/piper/domain";
import {
  openTrain,
  readTrain,
  stepTrain,
  viewTrain,
} from "@joelhooks/piper/host";
import { soloMetrics, trainMetrics } from "@joelhooks/piper/metrics";
import {
  openSolo,
  readSolo,
  stepSolo,
  viewSolo,
} from "@joelhooks/piper/solo-host";
import { Clock, Effect, Result, Schema } from "effect";

import { Auth } from "./auth.js";
import { decode, json, refuse, respond, stampedBody } from "./http.js";
import { metricsOptions } from "./metrics.js";
import { restoreSnapshot } from "./snapshot.js";
import { Storage } from "./storage.js";
import type { Document } from "./storage.js";

export type Kind = "train" | "solo";

const Tick = Schema.TaggedStruct("tick", TrainEvents.tick.fields);

const inspect = Effect.fn("Cell.inspect")(function* inspect(
  kind: Kind,
  encoded: string
) {
  const snapshot = yield* restoreSnapshot(encoded);

  return kind === "train"
    ? viewTrain(yield* readTrain(snapshot))
    : viewSolo(yield* readSolo(snapshot));
});

const open = Effect.fn("Cell.open")(function* open(
  kind: Kind,
  request: Request,
  at: number
) {
  const body = yield* stampedBody(request, at);

  return kind === "train"
    ? JSON.stringify(yield* openTrain(yield* decode(TrainInputSchema)(body)))
    : JSON.stringify(yield* openSolo(yield* decode(SoloInputSchema)(body)));
});

const step = Effect.fn("Cell.step")(function* step(
  kind: Kind,
  encoded: string,
  request: Request,
  at: number
) {
  const body = yield* stampedBody(request, at);
  const batch = Array.isArray(body) ? body : [body];

  if (kind === "train") {
    const posted = yield* decode(Schema.Array(PostedEventSchema))(batch);

    const next = yield* stepTrain(
      yield* restoreSnapshot(encoded),
      posted.map(toTrainEvent)
    );

    return { encoded: JSON.stringify(next), posted };
  }

  const posted = yield* decode(Schema.Array(PostedSoloEventSchema))(batch);

  const next = yield* stepSolo(
    yield* restoreSnapshot(encoded),
    posted.map(toSoloEvent)
  );

  return { encoded: JSON.stringify(next), posted };
});

const save = Effect.fn("Cell.save")(function* save(
  kind: Kind,
  document: Document
) {
  const storage = yield* Storage;
  yield* storage.save(document);

  if (document.snapshot === undefined) {
    return {};
  }

  const view = yield* inspect(kind, document.snapshot);
  yield* storage.alarm(view.alarmAt);

  return kind === "solo" ? { ...view, operator: document.notes } : view;
});

const measurements = Effect.fn("Cell.measurements")(function* measurements(
  kind: Kind,
  encoded: string,
  request: Request
) {
  const options = yield* metricsOptions(request);
  const snapshot = yield* restoreSnapshot(encoded);

  return kind === "train"
    ? trainMetrics((yield* readTrain(snapshot)).context.facts, options)
    : soloMetrics((yield* readSolo(snapshot)).context.facts, options);
});

const Note = Schema.Struct({
  action: Schema.NonEmptyString,
  at: Schema.Int,
  note: Schema.optionalKey(Schema.String),
});

const cellHandle = Effect.fn("Cell.handle")(function* cellHandle(
  kind: Kind,
  request: Request
) {
  const auth = yield* Auth;

  if (!(yield* auth.allowed(request))) {
    return refuse(401, "unauthorized");
  }

  const storage = yield* Storage;
  const document = yield* storage.load;
  const path = new URL(request.url).pathname;
  const at = yield* Clock.currentTimeMillis;

  if (path === "/open" && request.method === "POST") {
    if (document.snapshot !== undefined) {
      return refuse(409, "exists");
    }

    return yield* respond(
      open(kind, request, at).pipe(
        Effect.flatMap((snapshot) => save(kind, { ...document, snapshot }))
      ),
      201
    );
  }

  if (document.snapshot === undefined) {
    return refuse(404, "not-found");
  }

  if (path === "/metrics" && request.method === "GET") {
    return json(yield* measurements(kind, document.snapshot, request));
  }

  if (path === "/state" && request.method === "GET") {
    const view = yield* inspect(kind, document.snapshot);

    return json(kind === "solo" ? { ...view, operator: document.notes } : view);
  }

  if (path === "/events" && request.method === "GET") {
    return json(document.events);
  }

  if (path === "/events" && request.method === "POST") {
    const encoded = document.snapshot;

    return yield* respond(
      step(kind, encoded, request, at).pipe(
        Effect.flatMap((result) =>
          save(kind, {
            ...document,
            events: [
              ...document.events,
              ...result.posted.map((body, index) => ({
                body,
                received_at: at,
                seq: document.events.length + index + 1,
              })),
            ],
            snapshot: result.encoded,
          })
        )
      )
    );
  }

  if (kind === "solo" && path === "/operator" && request.method === "POST") {
    const note = yield* decode(Note)(yield* stampedBody(request, at)).pipe(
      Effect.result
    );

    if (Result.isFailure(note)) {
      return refuse(400, "bad-request");
    }

    return json(
      yield* save(kind, {
        ...document,
        notes: [
          ...document.notes,
          { ...note.success, note: note.success.note ?? null },
        ],
      })
    );
  }

  return refuse(404, "no-such-route");
});

export const cellFetch = (kind: Kind, request: Request) =>
  cellHandle(kind, request).pipe(
    Effect.catchTag("BadRequest", () =>
      Effect.succeed(refuse(400, "bad-request"))
    )
  );

export const cellAlarm = Effect.fn("Cell.alarm")(function* cellAlarm(
  kind: Kind
) {
  const storage = yield* Storage;
  const document = yield* storage.load;

  if (document.snapshot === undefined) {
    return;
  }

  const view = yield* inspect(kind, document.snapshot);

  if (view.status !== "active") {
    yield* storage.alarm(view.alarmAt);

    return;
  }

  const at = yield* Clock.currentTimeMillis;

  const next =
    kind === "train"
      ? yield* stepTrain(yield* restoreSnapshot(document.snapshot), [
          { at, type: "tick" },
        ])
      : yield* stepSolo(yield* restoreSnapshot(document.snapshot), [
          { at, type: "tick" },
        ]);

  yield* save(kind, {
    ...document,
    events: [
      ...document.events,
      {
        body: Tick.make({ at }),
        received_at: at,
        seq: document.events.length + 1,
      },
    ],
    snapshot: JSON.stringify(next),
  });
});
