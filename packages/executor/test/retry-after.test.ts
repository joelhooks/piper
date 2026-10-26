import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { ExecutorError } from "../src/domain.js";
import { retryAfterDelay } from "../src/transport.js";

const headers = Arbitrary.schema(Schema.Union([Schema.String, Schema.Finite]));

const hostile = [
  "",
  " ",
  "-1",
  "-0",
  "NaN",
  "Infinity",
  "-Infinity",
  "1e308",
  "1e999",
  "9".repeat(400),
  "Thu, 01 Jan 1970 00:00:00 GMT",
  "Fri, 31 Dec 9999 23:59:59 GMT",
  "soon",
];

describe("retry-after hint", () => {
  it.prop(
    "any header yields a finite non-negative delay",
    { header: headers, now: Schema.Finite },
    ({ header, now }) => {
      const delay = retryAfterDelay(String(header), now);

      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  );

  it("hostile headers yield a finite non-negative delay", () => {
    for (const header of [undefined, ...hostile]) {
      for (const now of [0, 1_700_000_000_000, Number.MAX_SAFE_INTEGER]) {
        const delay = retryAfterDelay(String(header), now);

        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("reads seconds and HTTP dates", () => {
    expect(retryAfterDelay("30", 0)).toBe(30_000);
    expect(retryAfterDelay("Thu, 01 Jan 1970 00:01:00 GMT", 10_000)).toBe(
      50_000
    );
  });
});

describe("ExecutorError.retryAfterMs", () => {
  it("refuses non-finite and negative delays", () => {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -1, -0.5]) {
      expect(() =>
        ExecutorError.make({
          code: "provider",
          message: "x",
          retryAfterMs: bad,
        })
      ).toThrow();
    }
  });

  it("accepts zero and positive delays", () => {
    expect(
      ExecutorError.make({ code: "provider", message: "x", retryAfterMs: 0 })
        .retryAfterMs
    ).toBe(0);
  });
});
