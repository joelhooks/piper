import { ConfigProvider, Effect, Layer, Match, Predicate } from "effect";
import type { Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import type { HttpClientRequest } from "effect/http";

import type { ObserveConfig } from "../src/domain.js";
import type { TokenName } from "../src/http.js";

export interface Sent {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly url: URL;
}

export type Reply =
  | {
      readonly kind: "json";
      readonly status: number;
      readonly value: Schema.Json;
    }
  | { readonly kind: "text"; readonly status: number; readonly text: string }
  | { readonly kind: "offline" };

export const json = (value: Schema.Json, status = 200): Reply => ({
  kind: "json",
  status,
  value,
});

export const text = (body: string, status = 200): Reply => ({
  kind: "text",
  status,
  text: body,
});

export const offline: Reply = { kind: "offline" };

const bodyText = (request: HttpClientRequest.HttpClientRequest) =>
  Predicate.isTagged(request.body, "Uint8Array")
    ? new TextDecoder().decode(request.body.body)
    : "";

export const fakeHttp = (sent: Sent[], route: (request: Sent) => Reply) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* respond() {
        const captured: Sent = {
          body: bodyText(request),
          headers: request.headers,
          method: request.method,
          url,
        };

        sent.push(captured);

        const reply = route(captured);

        return yield* Match.value(reply).pipe(
          Match.discriminatorsExhaustive("kind")({
            json: ({ status, value }) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(value, { status })
                )
              ),
            offline: () =>
              Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request }),
                })
              ),
            text: ({ status, text: body }) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(body, { status })
                )
              ),
          })
        );
      })
    )
  );

export const tokens: Readonly<Record<TokenName, string>> = {
  AXIOM_ORG_ID: "synthetic-org",
  AXIOM_TOKEN: "synthetic-axiom-token",
  VERCEL_TOKEN: "synthetic-vercel-token",
};

export const environment = (values: Readonly<Record<string, string>>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(values));

export const sha = "0123456789abcdef0123456789abcdef01234567";

export const config: ObserveConfig = {
  axiom: {
    dataset: "synthetic-logs",
    filter: "project == 'sample' and env == 'production'",
    hardFloorErrors: 0,
    maxRateRatio: 2,
    minRequests: 1000,
    statusField: "request.statusCode",
    windowMinutes: 15,
  },
  canary: [
    { contains: "Welcome", status: 200, url: "https://sample.test/" },
    { contains: "ok", status: 200, url: "https://sample.test/health" },
  ],
  sha,
  vercel: { projectId: "prj_synthetic", teamId: "team_synthetic" },
};
