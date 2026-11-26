import { v } from 'convex/values'
export const comparisonGoalValidator = v.union(v.literal('harnesses'), v.literal('models'), v.literal('mcp'), v.literal('custom'))
export const runSettingsValidator = v.object({ concurrency: v.number(), retries: v.number(), cpus: v.optional(v.number()), memoryMb: v.optional(v.number()), timeoutSeconds: v.optional(v.number()) })
const mcpToolValidator = v.object({ name: v.string(), description: v.string(), params: v.array(v.string()), required: v.array(v.string()) })
export const mcpToolsValidator = v.object({ probedAt: v.string(), servers: v.array(v.object({
  name: v.string(), status: v.union(v.literal('ok'), v.literal('error'), v.literal('not-probed')),
  server: v.optional(v.object({ name: v.string(), version: v.string() })), toolsHash: v.optional(v.string()),
  tools: v.optional(v.array(mcpToolValidator)), error: v.optional(v.string()),
})) })
export const profileValidator = v.object({ id: v.string(), digest: v.string(), title: v.string(), benchmark: v.string(), agent: v.string(), model: v.string(), tasks: v.number(), attempts: v.number(), timeoutSeconds: v.number(), setupCheck: v.boolean(), taskSet: v.optional(v.string()), vendor: v.optional(v.string()), maxAttempts: v.optional(v.number()), runSettingsVersion: v.optional(v.literal(1)), mcp: v.optional(v.array(v.string())), mcpTools: v.optional(mcpToolsValidator) })
export const runStatusValidator = v.union(v.literal('queued'), v.literal('running'), v.literal('cancelling'), v.literal('completed'), v.literal('failed'), v.literal('cancelled'), v.literal('interrupted'))
export const machineKindValidator = v.union(v.literal('laptop'), v.literal('desktop'), v.literal('mac-mini'), v.literal('mac-studio'), v.literal('server'), v.literal('cloud'), v.literal('linux'))
