export * as TaskAbortTool from "./task-abort.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Job } from "../../job.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"

export const name = "task_abort"

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID.annotate({
    description:
      "The sessionID of the subagent to abort, as returned by the subagent tool. Only subagents spawned by the current session can be aborted.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["aborted", "not-running"]),
  output: Schema.String,
})

export const description = [
  "Aborts a running subagent spawned by the current session.",
  "The child session's execution is interrupted and its job cancelled; this is the same kill as pressing Escape on the subagent in the TUI.",
  "The child's conversation is preserved: to continue its partial work without starting from zero, spawn a new subagent with the same sessionID (its history carries the findings), or distill its exported transcript into a fresh prompt.",
  "Only your own child sessions can be aborted; aborting any other session fails.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.task-abort",
  effect: Effect.fn("TaskAbortTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const child = yield* sessions
                .get(input.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                  ),
                )
              // Ancestry guard: a session may only abort subagents it spawned itself.
              if (child.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${input.sessionID} is not a child of the current session`,
                })
              yield* permission
                .assert({
                  action: name,
                  resources: [input.sessionID],
                  save: [input.sessionID],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.messageID,
                    id: context.id,
                  },
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `task_abort denied: ${input.sessionID}`, error }),
                  ),
                )
              // Same kill the foreground subagent path performs on interrupt:
              // execution interrupt + job cancel.
              const interrupted = yield* sessions
                .interrupt(input.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to interrupt ${input.sessionID}`, error }),
                  ),
                )
              yield* jobs.cancel(input.sessionID).pipe(Effect.orDie)
              const status = interrupted ? ("aborted" as const) : ("not-running" as const)
              return {
                sessionID: input.sessionID,
                status,
                output:
                  status === "aborted"
                    ? `Subagent ${input.sessionID} aborted. Its conversation is preserved; continue it with the subagent tool passing sessionID=${input.sessionID}.`
                    : `Subagent ${input.sessionID} was not actively running; its job was cancelled. Continue it with the subagent tool passing sessionID=${input.sessionID}.`,
              }
            }).pipe(
              Effect.map((output) => ({
                output,
                content: `<subagent sessionID="${output.sessionID}" state="${output.status}">\n${output.output}\n</subagent>`,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}