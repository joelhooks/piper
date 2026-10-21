import { Predicate, SchemaIssue } from "effect";
import type { Schema } from "effect";

const issueFormatter = SchemaIssue.makeFormatterStandardSchemaV1();

export const schemaIssuePaths = (cause: Schema.SchemaError) =>
  [
    ...new Set(
      issueFormatter(cause.issue).issues.map((issue) =>
        (issue.path ?? [])
          .map((segment) =>
            String(
              Predicate.hasProperty(segment, "key") ? segment.key : segment
            )
          )
          .join(".")
      )
    ),
  ].toSorted();
