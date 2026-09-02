import { readFileSync } from "node:fs";

import { parse } from "yaml";

import { mandateSchema, type Mandate } from "./schema.js";

export function loadMandate(path: string): Mandate {
  const document = parse(readFileSync(path, "utf8")) as unknown;
  return mandateSchema.parse(document);
}
