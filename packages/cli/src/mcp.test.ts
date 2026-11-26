import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connectMerge } from './merge'
import { loadProfiles, readMcpSetup, setupMergeProfiles, snapshotProfile, validateMcpServers } from './runner/profiles'
import { readJson, writeJson } from './runner/files'
import { supervise, type Outcome } from './runner/supervisor'
import type { Catalog } from '../../../harbor/gateway/catalog'

const directories: string[] = []
function state() { const path = mkdtempSync(join(tmpdir(), 'openeval-mcp-')); directories.push(path); return path }
afterEach(() => { directories.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
const model = 'anthropic/test-model'
const catalog: Catalog = { schemaVersion: 1, fetchedAt: '2026-11-25T00:00:00Z', source: 'test', models: [
  { model, displayName: 'Test', creator: 'anthropic', vendors: [{ vendor: 'test', status: 'available', supportsToolCalling: true, supportsReasoning: false, contextWindow: null, maxOutputTokens: null, inputPerMillion: null, outputPerMillion: null, cacheReadPerMillion: null }] },
] }
const bundledTask = resolve(import.meta.dirname, '../runner-task')
const context7 = { name: 'context7', transport: 'streamable-http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer ${CONTEXT7_KEY}' } }
const files = { name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'example-files-mcp'] }

async function worker() {
  const directory = state()
  await connectMerge(directory, 'merge-test-key', async () => catalog)
  const servers = join(directory, 'servers.json'), env = join(directory, 'mcp.env')
  writeFileSync(servers, JSON.stringify({ servers: [context7, files] }))
  writeFileSync(env, 'CONTEXT7_KEY="mcp-secret-value"\nUNRELATED=keep-on-worker\n')
  return { directory, servers, env }
}

test('MCP setups become separate approved profiles that publish only server names', async () => {
  const { directory, servers, env } = await worker()
  const [plain] = setupMergeProfiles(directory, bundledTask, model, ['claude-code'])
  const [withMcp] = setupMergeProfiles(directory, bundledTask, model, ['claude-code'], undefined, undefined, readMcpSetup(servers, env))
  expect(withMcp).not.toBe(plain)
  // Running setup again with the same servers keeps the existing approval.
  expect(setupMergeProfiles(directory, bundledTask, model, ['claude-code'], undefined, undefined, readMcpSetup(servers, env))).toEqual([withMcp])
  const loaded = loadProfiles(join(directory, 'profiles.json'))
  const a = loaded.find(p => p.public.id === plain)!, b = loaded.find(p => p.public.id === withMcp)!
  expect(a.public.mcp).toBeUndefined()
  expect(b.public).toMatchObject({ agent: 'claude-code', model, mcp: ['context7', 'files'], title: 'Merge smoke: claude-code + MCP: context7, files' })
  expect(b.public.digest).not.toBe(a.public.digest)
  expect(JSON.stringify(b.public)).not.toContain('example.test')
  expect(JSON.stringify(b)).not.toContain('mcp-secret-value')
})

test('the supervisor passes only referenced MCP variables to Harbor and keeps them out of artifacts', async () => {
  const { directory, servers, env } = await worker()
  const [id] = setupMergeProfiles(directory, bundledTask, model, ['claude-code'], undefined, undefined, readMcpSetup(servers, env))
  const profile = loadProfiles(join(directory, 'profiles.json')).find(p => p.public.id === id)!
  const fake = join(directory, 'fake-harbor')
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const agent = JSON.parse(fs.readFileSync('harbor.json')).agents[0];
if (process.env.CONTEXT7_KEY !== 'mcp-secret-value') process.exit(3);
if (process.env.UNRELATED) process.exit(4);
if (agent.mcp_servers[0].headers.Authorization !== 'Bearer \${CONTEXT7_KEY}') process.exit(5);
fs.mkdirSync('jobs/evaluation/trial', {recursive:true});
fs.writeFileSync('jobs/evaluation/trial/config.json', JSON.stringify({agent}));
fs.writeFileSync('jobs/evaluation/trial/result.json', JSON.stringify({finished_at:new Date().toISOString(),task_name:'heval-setup', verifier_result:{rewards:{reward:1}}, agent_info:{name:agent.name, version:'test'}}));
`, { mode: 0o700 })
  const run = state()
  snapshotProfile(profile, run)
  writeJson(join(run, 'execution.json'), { claimId: 'test', harbor: fake, timeoutSeconds: 10, mcpEnvFile: profile.mcpEnvFile, mergeConnection: profile.mergeConnection })
  await supervise(run)
  const outcome = readJson<Outcome>(join(run, 'outcome.json'))
  expect(outcome.status).toBe('completed')
  expect(JSON.parse(outcome.json!).rows).toMatchObject([{ mcp: 'context7, files', stack: 'claude-code / test-model + context7, files' }])
  for (const file of ['outcome.json', 'harbor.json', 'execution.json']) expect(readFileSync(join(run, file), 'utf8')).not.toContain('mcp-secret-value')
})

test('MCP servers are checked before they reach Harbor', async () => {
  expect(validateMcpServers([files, context7], 'codex')).toEqual({ names: ['context7', 'files'], variables: ['CONTEXT7_KEY'] })
  expect(() => validateMcpServers([context7], 'pi')).toThrow('MCP headers need codex or claude-code')
  expect(() => validateMcpServers([files], 'deep-agents')).toThrow('cannot use MCP servers')
  expect(() => validateMcpServers([{ ...context7, headers: { Authorization: 'Bearer literal-token' } }], 'codex')).toThrow('MCP env file')
  expect(() => validateMcpServers([{ ...context7, headers: { Authorization: 'Bearer ${TOKEN:-fallback}' } }], 'codex')).toThrow('without defaults')
  expect(() => validateMcpServers([{ ...files, url: 'https://x.test' }], 'codex')).toThrow('not url or headers')
  expect(() => validateMcpServers([{ ...context7, url: 'https://user:pass@x.test' }], 'codex')).toThrow('without credentials')
  expect(() => validateMcpServers([files, files], 'codex')).toThrow('different name')
  expect(() => validateMcpServers([{ ...files, cwd: '/' }], 'codex')).toThrow('Unsupported MCP server field')
  expect(() => validateMcpServers([], 'codex')).toThrow('1 to 8')

  const { directory, servers, env } = await worker()
  expect(() => setupMergeProfiles(directory, bundledTask, model, ['claude-code'], undefined, undefined, readMcpSetup(servers))).toThrow('Pass --mcp-env')
  writeFileSync(env, 'UNRELATED=1\n')
  expect(() => setupMergeProfiles(directory, bundledTask, model, ['claude-code'], undefined, undefined, readMcpSetup(servers, env))).toThrow('does not set CONTEXT7_KEY')
  expect(() => setupMergeProfiles(directory, bundledTask, model, ['pi'], undefined, undefined, readMcpSetup(servers, env))).toThrow('MCP headers need')
})
