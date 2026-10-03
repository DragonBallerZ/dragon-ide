import { describe, expect } from "bun:test"
import { BedrockConverse, OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect } from "effect"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const session = Session.Info.make({
  id: Session.ID.make("ses_output_limit"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})
const resolved = (model: Parameters<typeof SessionRunnerModel.resolved>[0], output: number) =>
  SessionRunnerModel.resolved(model, {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output },
  })
const bedrock = BedrockConverse.route.with({ endpoint: { baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com" } })
const sonnet = bedrock.model({ id: "global.anthropic.claude-sonnet-5-5", provider: "amazon-bedrock" })

const maxTokens = (model: SessionRunnerModel.Resolved) =>
  Effect.gen(function* () {
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    const prepared = yield* requests.primary({ session, agent: Agent.ID.make("build"), model, system: [], messages: [] })
    return prepared.request.generation?.maxTokens
  })

describe("SessionModelRequest output limit", () => {
  it.effect("sends Claude on Bedrock its output limit, which Converse otherwise caps at 4,096", () =>
    Effect.gen(function* () {
      expect({
        large: yield* maxTokens(resolved(sonnet, 128_000)),
        small: yield* maxTokens(
          resolved(bedrock.model({ id: "anthropic.claude-3-haiku", provider: "amazon-bedrock" }), 4_096),
        ),
        unknown: yield* maxTokens(resolved(sonnet, 0)),
        otherBedrock: yield* maxTokens(
          resolved(bedrock.model({ id: "meta.llama3-70b", provider: "amazon-bedrock" }), 2_048),
        ),
        openai: yield* maxTokens(resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), 128_000)),
      }).toEqual({ large: 32_000, small: 4_096, unknown: undefined, otherBedrock: undefined, openai: undefined })
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("keeps an output limit a plugin set", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.options.maxTokens = 8_000
        }),
      )
      expect(yield* maxTokens(resolved(sonnet, 128_000))).toBe(8_000)
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )
})
