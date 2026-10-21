import { Predicate, SchemaIssue } from "effect";
import type { Schema } from "effect";

const issueFormatter = SchemaIssue.makeFormatterStandardSchemaV1();

type IssuePath = ReturnType<typeof issueFormatter>["issues"][number]["path"];

const dotted = (path: IssuePath) =>
  (path ?? [])
    .map((segment) =>
      String(Predicate.hasProperty(segment, "key") ? segment.key : segment)
    )
    .join(".");

export const schemaIssuePaths = (cause: Schema.SchemaError) =>
  [
    ...new Set(
      issueFormatter(cause.issue).issues.map(({ path }) => dotted(path))
    ),
  ].toSorted();

const unexplained = "";

const authored = (issue: SchemaIssue.Issue) =>
  Predicate.isTagged(issue, "InvalidValue")
    ? issue.annotations?.message
    : undefined;

const reasonFormatter = SchemaIssue.makeFormatterStandardSchemaV1({
  checkHook: ({ filter, issue }) =>
    Predicate.isTagged(issue, "InvalidValue")
      ? (authored(issue) ?? filter.annotations?.message ?? unexplained)
      : undefined,
  leafHook: (issue) => authored(issue) ?? unexplained,
});

export const schemaIssueReasons = (cause: Schema.SchemaError) =>
  reasonFormatter(cause.issue).issues.flatMap(({ message, path }) =>
    message === unexplained ? [] : [{ path: dotted(path), reason: message }]
  );
