import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { retryDelay } from "../src/http.js";

const headers = Arbitrary.schema(Schema.Union([Schema.String, Schema.Finite]));

describe("shadow retry delay", () => {
  it.prop(
    "any header yields a finite non-negative delay",
    { header: headers, now: Schema.Finite },
    ({ header, now }) => {
      const delay = retryDelay(String(header), now);

      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  );

  it("overflowing, negative and junk headers fall back to the default", () => {
    for (const header of ["1e308", "-5", "NaN", "Infinity", "soon", ""]) {
      expect(retryDelay(header, 0)).toBe(60_000);
    }
  });
});
