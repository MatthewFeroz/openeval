/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { expect, test } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'
import type { RunnerProfile } from '../src/runners/protocol'
import fixture from '../results/harbor/demo-evaluation.json'
const modules = import.meta.glob(['./**/*.ts', './**/*.js', '!./**/*.test.ts'])
const key = (n: number) => n.toString(16).padStart(64, '0')

async function setup() {
  const t = convexTest(schema, modules), owner = t.withIdentity({ subject: 'owner' }), stranger = t.withIdentity({ subject: 'stranger' })
  const profiles: RunnerProfile[] = ['codex', 'pi'].map((agent, i) => ({ id: agent, digest: key(i + 1), agent, model: 'test/model', vendor: 'test', title: agent, benchmark: 'Synthetic test fixture', tasks: 1, attempts: 1, maxAttempts: 2, taskSet: key(99), timeoutSeconds: 600, setupCheck: false, runSettingsVersion: 1 }))
  await owner.mutation(api.runners.createPairing, { name: 'Fixture worker', code: key(10) })
  const { id: runner } = await t.mutation(api.runners.connect, { code: key(10), credential: key(11) })
  const poll = (p = profiles) => t.mutation(api.runners.poll, { credential: key(11), session: key(12), claimId: key(13), ready: true, health: 'Ready', profiles: p })
  await poll()
  const args = { runner, title: 'Harness comparison', goal: 'harnesses' as const, requestId: key(20), attempts: 1, profiles: profiles.map(p => ({ id: p.id, digest: p.digest })) }
  return { t, owner, stranger, profiles, poll, args }
}

test('comparison questions enforce controlled conditions at the backend', async () => {
  const { owner, args, poll, profiles } = await setup()
  await expect(owner.mutation(api.experiments.create, { ...args, profiles: [args.profiles[0]] })).rejects.toThrow('two harnesses')
  await expect(owner.mutation(api.experiments.create, { ...args, goal: 'models' })).rejects.toThrow('two models')
  await poll(profiles.map((p, i) => i ? { ...p, tasks: 2 } : p))
  await expect(owner.mutation(api.experiments.create, args)).rejects.toThrow('same task snapshot and task count')
  expect(await owner.query(api.experiments.list)).toHaveLength(0)
})

test('baselines are private immutable snapshots, and repeats preserve conditions', async () => {
  const { t, owner, stranger, args, poll, profiles } = await setup()
  const experiment = await owner.mutation(api.experiments.create, args)
  await expect(owner.mutation(api.baselines.save, { experiment, title: 'Baseline' })).rejects.toThrow('finish')
  for (let i = 0; i < 2; i++) {
    const run = (await poll())!
    await t.mutation(api.runners.finish, { credential: key(11), session: key(12), claimId: key(13), id: run.id, status: 'completed', json: JSON.stringify({ ...fixture, rows: [fixture.rows[i]] }) })
  }
  const id = await owner.mutation(api.baselines.save, { experiment, title: 'Baseline' })
  expect(await owner.mutation(api.baselines.save, { experiment, title: 'Another title' })).toBe(id)
  const saved = await owner.query(api.baselines.get, { id })
  expect(saved.results).toHaveLength(2)
  expect(saved.profiles).toEqual(profiles)
  await expect(stranger.query(api.baselines.get, { id })).rejects.toThrow('not found')
  await expect(stranger.mutation(api.baselines.save, { experiment, title: 'Stolen' })).rejects.toThrow('not found')
  expect(await stranger.query(api.baselines.list)).toEqual([])
  await expect(owner.mutation(api.experiments.create, { ...args, requestId: key(21), attempts: 2, baseline: id })).rejects.toThrow('Keep the baseline')
  await expect(owner.mutation(api.experiments.create, { ...args, requestId: key(22), baseline: id, runSettings: { concurrency: 2, retries: 0 } })).rejects.toThrow('Keep the baseline')
  const updated = profiles.map(p => ({ ...p, digest: key(70), model: 'test/new-model' }))
  await poll(updated)
  const repeat = await owner.mutation(api.experiments.create, { ...args, requestId: key(23), baseline: id, profiles: updated.map(p => ({ id: p.id, digest: p.digest })) })
  expect((await owner.query(api.experiments.get, { id: repeat })).baseline).toBe(id)
  expect(await owner.query(api.baselines.get, { id })).toEqual(saved)
})

test('combined comparisons retain private lifecycle and reviewed evidence with stable trial mappings', async () => {
  const { t, owner, args, poll } = await setup()
  const experiment = await owner.mutation(api.experiments.create, args)
  for (let index = 0; index < 2; index++) {
    const run = (await poll())!, trial = fixture.rows[index].trial
    const claim = { credential: key(11), session: key(12), claimId: key(13), id: run.id }
    await t.mutation(api.runners.monitor, { ...claim, snapshot: { sequence: 1, sampledAt: 100, trials: [{ id: trial, state: 'passed', startedAt: 10, updatedAt: 90, finishedAt: 90 }], events: [] } })
    await t.mutation(api.runners.finish, { ...claim, status: 'completed', json: JSON.stringify({ ...fixture, rows: [fixture.rows[index]] }) })
    await t.mutation(api.runners.captureEvidence, { ...claim, entries: [{ trial, title: 'Synthetic reviewed verifier', kind: 'verifier', text: `Demonstration ${index}` }] })
  }
  const detail = await owner.query(api.experiments.get, { id: experiment })
  const report = (await owner.query(api.reports.get, { id: detail.report! }))!
  expect(report.evidence).toHaveLength(4)
  const trials = new Set(JSON.parse(report.data).rows.map((row: { trial: string }) => row.trial))
  expect(report.evidence.every(item => trials.has(item.trial) && !item.published)).toBe(true)
  await owner.mutation(api.reports.share, { id: detail.report!, token: key(1000) })
  expect((await t.query(api.reports.shared, { token: key(1000) }))!.evidence).toEqual([])
  await owner.mutation(api.reportEvidence.setPublished, { id: report.evidence[0].id, reviewed: true, published: true })
  expect((await t.query(api.reports.shared, { token: key(1000) }))!.evidence).toHaveLength(1)
})

test('MCP comparisons vary only the MCP setup, and other questions hold it fixed', async () => {
  const { owner, args, poll, profiles } = await setup()
  const base = { ...profiles[0], id: 'codex-plain', digest: key(31) }
  const withMcp = { ...profiles[0], id: 'codex-mcp', digest: key(32), mcp: ['context7'] }
  const otherMcp = { ...profiles[0], id: 'codex-other', digest: key(33), mcp: ['context7'] }
  await poll([...profiles, base, withMcp, otherMcp])
  const pick = (...items: RunnerProfile[]) => items.map(p => ({ id: p.id, digest: p.digest }))
  const mcp = { ...args, title: 'MCP comparison', goal: 'mcp' as const }
  await expect(owner.mutation(api.experiments.create, { ...mcp, requestId: key(40), profiles: pick(withMcp, otherMcp) })).rejects.toThrow('two different MCP setups')
  await expect(owner.mutation(api.experiments.create, { ...mcp, requestId: key(41), profiles: pick(profiles[1], withMcp) })).rejects.toThrow('one harness')
  await expect(owner.mutation(api.experiments.create, { ...args, requestId: key(42), profiles: pick(profiles[1], withMcp) })).rejects.toThrow('same MCP setup')
  await expect(owner.mutation(api.experiments.create, { ...args, goal: 'custom', requestId: key(43), profiles: pick(withMcp, otherMcp) })).rejects.toThrow('must be unique')
  const id = await owner.mutation(api.experiments.create, { ...mcp, requestId: key(44), profiles: pick(base, withMcp) })
  const detail = await owner.query(api.experiments.get, { id })
  expect(detail.goal).toBe('mcp')
  expect(detail.cells.map(cell => cell.profile.mcp ?? null).sort()).toEqual([['context7'], null].sort())
})

test('workers can publish informational MCP tool lists, and invalid tool lists are rejected', async () => {
  const { owner, poll, profiles } = await setup()
  const mcpTools = {
    probedAt: '2026-11-25T20:00:00.000Z',
    servers: [{
      name: 'context7', status: 'ok' as const, server: { name: 'Context7', version: '4.7.3' }, toolsHash: 'efa09f9ae72e',
      tools: [{ name: 'query-docs', description: 'Query docs.', params: ['libraryId', 'query'], required: ['libraryId', 'query'] }],
    }],
  }
  const valid = { ...profiles[0], id: 'codex-mcp', digest: key(51), mcp: ['context7'], mcpTools }
  await poll([...profiles, valid])
  const listed = await owner.query(api.runners.list)
  expect(listed[0].profiles.find(p => p.id === 'codex-mcp')?.mcpTools).toEqual(mcpTools)
  await expect(poll([{ ...profiles[0], id: 'codex-no-mcp', digest: key(52), mcpTools }])).rejects.toThrow('Invalid MCP tool list')
  await expect(poll([{ ...valid, mcpTools: { ...mcpTools, servers: [{ name: 'other', status: 'ok' }] } }])).rejects.toThrow('Invalid MCP tool list')
})
