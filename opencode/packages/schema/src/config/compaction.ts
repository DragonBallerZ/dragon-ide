export * as ConfigCompaction from "./compaction.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"

export class Keep extends Schema.Class<Keep>("Config.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(optional),
}) {}

export class Info extends Schema.Class<Info>("Config.Compaction")({
  auto: Schema.Boolean.pipe(optional),
  keep: Keep.pipe(optional),
  buffer: NonNegativeInt.pipe(optional),
  // DRAGON: compact once the prompt reaches this fraction of the model's context window, when that comes
  // before the buffered ceiling. 1 leaves the ceiling as it is.
  threshold: Schema.Finite.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(1)).pipe(optional),
}) {}
