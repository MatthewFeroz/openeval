import { existsSync, mkdirSync, cpSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { validateProfiles, executionTimeoutSeconds, MAX_MCP_SERVERS, MCP_SERVER_NAME, type RunSettings, type RunnerProfile } from '../../../../src/runners/protocol'
import { BENCHMARKS, type Benchmark } from '../../../../src/runners/benchmarks'
import { fingerprintDirectory, hashDirectory, randomSecret, readJson, sha256, writeJson, type TaskExecutionMetadata, type TaskFingerprint } from './files'
import { mergeAgent, mergePath, mergeStatus, selectMergeHarnesses } from '../merge'
import { bundledAdapters } from './bundled-adapters'

type JsonObject = Record<string, unknown>
type Descriptor = { id: string; title: string; benchmark: string; config: string; timeoutSeconds: number; envFile?: string; mcpEnvFile?: string; maxAttempts?: number; provider?: 'merge' }
export type LocalProfile = { public: RunnerProfile; config: JsonObject; taskPaths: string[]; taskHashes: string[]; taskExecutionMetadata: TaskExecutionMetadata[]; envFile?: string; mcpEnvFile?: string; mergeConnection?: string }
const object = (value: unknown): JsonObject => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object in the profile.'); return value as JsonObject }

/** Harbor 0.27 agents that accept MCP servers, and the subset that forwards HTTP headers. */
export const MCP_HARNESSES = ['codex', 'claude-code', 'opencode', 'pi', 'terminus-2', 'grok-build']
export const MCP_HEADER_HARNESSES = ['codex', 'claude-code']
const reference = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const printable = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && ![...value].some(c => c.charCodeAt(0) < 32)

/**
 * Check MCP servers before they reach Harbor. Credentials must be `${VAR}`
 * references that the worker fills in at launch, never values in the profile.
 */
export function validateMcpServers(value: unknown, harness: string): { names: string[]; variables: string[] } {
  if (!MCP_HARNESSES.includes(harness)) throw new Error(`${harness} cannot use MCP servers. Use one of: ${MCP_HARNESSES.join(', ')}.`)
  if (!Array.isArray(value) || !value.length || value.length > MAX_MCP_SERVERS) throw new Error(`Use 1 to ${MAX_MCP_SERVERS} MCP servers.`)
  const names: string[] = [], variables = new Set<string>()
  for (const item of value) {
    const server = object(item)
    for (const key of Object.keys(server)) if (!['name', 'transport', 'url', 'command', 'args', 'headers'].includes(key)) throw new Error(`Unsupported MCP server field: ${key}`)
    if (typeof server.name !== 'string' || !MCP_SERVER_NAME.test(server.name)) throw new Error('Name each MCP server with up to 64 letters, numbers, hyphens or underscores.')
    names.push(server.name)
    const transport = server.transport === undefined ? 'sse' : server.transport === 'http' ? 'streamable-http' : server.transport
    if (transport === 'stdio') {
      if (server.url !== undefined || server.headers !== undefined) throw new Error(`MCP server ${server.name}: stdio servers take command and args, not url or headers.`)
      if (!printable(server.command, 1024)) throw new Error(`MCP server ${server.name}: give the command to run inside the task container.`)
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.length > 64 || server.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || [...arg].some(c => c.charCodeAt(0) < 32)))) throw new Error(`MCP server ${server.name}: args must be a list of strings.`)
    } else if (transport === 'sse' || transport === 'streamable-http') {
      if (server.command !== undefined || server.args !== undefined) throw new Error(`MCP server ${server.name}: remote servers take url and headers, not command or args.`)
      let url: URL
      try { url = new URL(String(server.url)) } catch { throw new Error(`MCP server ${server.name}: give an http or https url.`) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`MCP server ${server.name}: give an http or https url without credentials.`)
      if (server.headers !== undefined) {
        const headers = object(server.headers)
        if (Object.keys(headers).length && !MCP_HEADER_HARNESSES.includes(harness)) throw new Error(`MCP headers need ${MCP_HEADER_HARNESSES.join(' or ')}; Harbor does not forward them for ${harness}.`)
        if (Object.keys(headers).length > 16) throw new Error(`MCP server ${server.name}: use at most 16 headers.`)
        for (const [header, raw] of Object.entries(headers)) {
          if (!/^[A-Za-z0-9-]{1,64}$/.test(header) || !printable(raw, 4096)) throw new Error(`MCP server ${server.name}: invalid header ${header}.`)
          const found = [...raw.matchAll(reference)].map(match => match[1])
          if (raw.replace(reference, '').includes('${')) throw new Error(`MCP server ${server.name}: write header variables as \${NAME}, without defaults.`)
          if (/authorization|cookie|key|token|secret/i.test(header) && !found.length) throw new Error(`MCP server ${server.name}: put the ${header} credential in the MCP env file and reference it as \${NAME}.`)
          found.forEach(name => variables.add(name))
        }
      }
    } else throw new Error(`MCP server ${server.name}: use transport stdio, sse or streamable-http.`)
  }
  if (new Set(names).size !== names.length) throw new Error('Give each MCP server a different name.')
  return { names: names.sort(), variables: [...variables].sort() }
}

/** Read only the requested variables from a KEY=VALUE env file. */
export function readMcpEnv(file: string, variables: string[]): Record<string, string> {
  if (readFileSync(file).length > 100_000) throw new Error('The MCP env file must be smaller than 100 KB.')
  const values: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match || !variables.includes(match[1])) continue
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  const missing = variables.filter(name => !values[name])
  if (missing.length) throw new Error(`The MCP env file does not set ${missing.join(', ')}.`)
  return values
}
export function initializeProfiles(directory: string, bundledTask: string) {
  const path = join(directory, 'profiles.json')
  if (existsSync(path)) return path
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  // Explicit traversal avoids Node's native recursive-copy failure on Docker Desktop bind mounts.
  cpSync(bundledTask, join(directory, 'tasks/heval-setup'), { recursive: true, filter: name => !name.split('/').some(part => part === '.git' || part === '__pycache__') })
  writeJson(join(directory, 'setup.json'), { n_attempts: 1, agents: [{ name: 'oracle' }], tasks: [{ path: 'tasks/heval-setup' }] })
  writeJson(path, { schemaVersion: 1, profiles: [{ id: 'heval-setup', title: 'Check this machine', benchmark: 'OpenEval setup check v1', config: 'setup.json', timeoutSeconds: 300 }] })
  return path
}
export function loadProfiles(file: string, connectionDirectory = dirname(file)): LocalProfile[] {
  if (readFileSync(file).length > 100_000) throw new Error('The profile registry must be smaller than 100 KB.')
  const registry = readJson<{ schemaVersion: number; profiles: Descriptor[] }>(file)
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.profiles)) throw new Error('Use a schemaVersion 1 profile registry.')
  // Share reads within this scan only; the next poll must recheck task contents.
  const hashesByPath = new Map<string, TaskFingerprint>()
  const loaded = registry.profiles.map(d => {
    const path = resolve(dirname(file), d.config)
    if (readFileSync(path).length > 100_000) throw new Error('Use a Harbor JSON config smaller than 100 KB.')
    const input = readJson<JsonObject>(path)
    for (const key of Object.keys(input)) if (!['n_attempts', 'agents', 'tasks'].includes(key)) throw new Error(`Unsupported profile config field: ${key}. This release accepts n_attempts, agents, and explicit local tasks.`)
    if (!Array.isArray(input.agents) || input.agents.length !== 1 || !Array.isArray(input.tasks) || !input.tasks.length) throw new Error('Approve one agent/model and one or more explicit local task directories per profile.')
    let agent = object(input.agents[0])
    if (!['oracle', 'codex', 'claude-code', 'opencode', 'pi', 'terminus-2', 'grok-build', ...(d.provider === 'merge' ? ['deep-agents'] : [])].includes(String(agent.name)) || agent.import_path) throw new Error('Use a built-in supported Harbor agent or the bundled Merge Deep Agents adapter.')
    for (const key of Object.keys(agent)) if (!['name', 'model_name', 'kwargs', 'env', 'override_timeout_sec', 'override_setup_timeout_sec', 'mcp_servers'].includes(key)) throw new Error(`Unsupported agent field: ${key}`)
    const mcp = agent.mcp_servers === undefined ? undefined : validateMcpServers(agent.mcp_servers, String(agent.name))
    if (d.mcpEnvFile !== undefined && !mcp?.variables.length) throw new Error('Remove mcpEnvFile, or reference its variables from MCP headers.')
    if (agent.name !== 'oracle' && (typeof agent.model_name !== 'string' || !agent.model_name)) throw new Error('A model-backed profile needs model_name.')
    const displayModel = String(agent.model_name)
    if (d.provider !== undefined && d.provider !== 'merge') throw new Error('Unsupported profile provider.')
    if (d.provider === 'merge') {
      if (d.envFile || agent.env || agent.kwargs) throw new Error('Merge profiles manage credentials and harness settings automatically. Remove envFile, agent.env and agent.kwargs.')
      const connection = mergeStatus(connectionDirectory)
      if (!connection.connected || !connection.models.includes(displayModel)) throw new Error('Connect Merge and select a model from the validated catalog.')
      agent = { ...agent, ...mergeAgent(String(agent.name), displayModel) }
    }
    const taskPaths = input.tasks.map(t => {
      const task = object(t)
      if (typeof task.path !== 'string' || Object.keys(task).some(k => k !== 'path')) throw new Error('Each approved task must contain just its local path.')
      const path = resolve(dirname(resolve(dirname(file), d.config)), task.path)
      if (!existsSync(join(path, 'task.toml')) || !existsSync(join(path, 'instruction.md'))) throw new Error('Each approved task needs task.toml and instruction.md.')
      return path
    })
    const fingerprints = taskPaths.map(path => {
      let hash = hashesByPath.get(path)
      if (hash === undefined) { hash = fingerprintDirectory(path); hashesByPath.set(path, hash) }
      return hash
    })
    const taskHashes = fingerprints.map(hash => hash.contentHash)
    const taskExecutionMetadata = fingerprints.map(hash => hash.executionMetadata)
    // Docker's auto policy enforces declared limits, while accepting benchmark
    // tasks that omit a resource value. Explicit "limit" rejects those tasks.
    const config = { n_attempts: input.n_attempts ?? 1, n_concurrent_trials: 1, retry: { max_retries: 0 }, agents: [agent], tasks: taskPaths.map(path => ({ path })), environment: { type: 'docker', delete: true, cpu_enforcement_policy: 'auto', memory_enforcement_policy: 'auto' } }
    let mcpEnvFile: string | undefined
    if (mcp?.variables.length) {
      if (!d.mcpEnvFile) throw new Error('MCP headers reference variables. Add mcpEnvFile with their values.')
      mcpEnvFile = isAbsolute(d.mcpEnvFile) ? d.mcpEnvFile : resolve(dirname(file), d.mcpEnvFile)
      if (!existsSync(mcpEnvFile)) throw new Error('The profile mcpEnvFile does not exist on this machine.')
      readMcpEnv(mcpEnvFile, mcp.variables)
    }
    const description = { runSettingsVersion: 1 as const, ...(mcp ? { mcp: mcp.names } : {}), id: d.id, title: d.title, benchmark: d.benchmark, agent: String(agent.name), model: agent.name === 'oracle' ? 'Reference solution (no model)' : displayModel, tasks: taskPaths.length, attempts: Number(config.n_attempts), timeoutSeconds: d.timeoutSeconds, setupCheck: agent.name === 'oracle', taskSet: sha256(JSON.stringify(taskHashes)), vendor: typeof object(agent.env ?? {}).HEVAL_VENDOR === 'string' ? String(object(agent.env ?? {}).HEVAL_VENDOR) : 'Provider default', maxAttempts: d.maxAttempts ?? Number(config.n_attempts) }
    // Include all executable task content and agent settings, excluding local path names.
    const adapter = agent.name === 'deep-agents' ? sha256(readFileSync(join(bundledAdapters(), 'heval_agents.py'), 'utf8')) : undefined
    const digest = sha256(JSON.stringify({ description, config: { ...config, tasks: taskHashes }, taskExecutionMetadata, ...(adapter ? { adapter } : {}) }))
    let envFile: string | undefined
    if (d.envFile) { envFile = isAbsolute(d.envFile) ? d.envFile : resolve(dirname(file), d.envFile); if (!existsSync(envFile)) throw new Error('The profile envFile does not exist on this machine.') }
    return { public: { ...description, digest }, config, taskPaths, taskHashes, taskExecutionMetadata, envFile, ...(mcpEnvFile ? { mcpEnvFile } : {}), ...(d.provider === 'merge' ? { mergeConnection: mergePath(connectionDirectory) } : {}) }
  })
  validateProfiles(loaded.map(p => p.public))
  return loaded
}

const copyTask = (from: string, to: string) => cpSync(from, to, { recursive: true, filter: name => !name.split('/').some(part => part === '.git' || part === '__pycache__') })

/** Copy a catalog benchmark's pinned tasks into the runner state, refusing any content that differs from the pin. */
function installBenchmark(directory: string, id: string, source: string, catalog: Benchmark[]) {
  const benchmark = catalog.find(b => b.id === id)
  if (!benchmark || benchmark.id === 'openeval-smoke' || !benchmark.taskHashes || benchmark.status === 'unsupported') throw new Error(`Choose an installable benchmark: ${catalog.filter(b => b.taskHashes && b.status !== 'unsupported' && b.id !== 'openeval-smoke').map(b => b.id).join(', ')}.`)
  const target = join(directory, 'benchmarks', benchmark.id)
  for (const [task, expected] of benchmark.taskHashes) {
    const path = join(resolve(source), task)
    if (!existsSync(join(path, 'task.toml'))) throw new Error(`${task} is missing from ${source}. Check out ${benchmark.source?.commit ?? 'the pinned commit'} first.`)
    if (hashDirectory(path) !== expected) throw new Error(`${task} differs from the pinned ${benchmark.title} content. Check out ${benchmark.source?.commit ?? 'the pinned commit'} and try again.`)
  }
  if (!existsSync(target)) {
    const staging = `${target}.${randomSecret().slice(0, 8)}.tmp`
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    try { for (const [task] of benchmark.taskHashes) copyTask(join(resolve(source), task), join(staging, task)); renameSync(staging, target) } finally { rmSync(staging, { recursive: true, force: true }) }
  }
  if (benchmark.taskHashes.some(([task, expected]) => hashDirectory(join(target, task)) !== expected)) throw new Error(`The installed copy in ${target} was modified. Remove it and run setup again.`)
  return benchmark
}

export type McpSetup = { servers: unknown[]; envFile?: string }
/** Read `runner setup --mcp`: a JSON list of Harbor MCP servers, or `{ "servers": [...] }`. */
export function readMcpSetup(file: string, envFile?: string): McpSetup {
  if (readFileSync(file).length > 100_000) throw new Error('The MCP server file must be smaller than 100 KB.')
  const input = readJson<unknown>(file)
  const servers = Array.isArray(input) ? input : object(input).servers
  if (!Array.isArray(servers)) throw new Error('List MCP servers as a JSON array, or as { "servers": [...] }.')
  return { servers, ...(envFile ? { envFile: resolve(envFile) } : {}) }
}

/** Add explicit smoke profiles without changing existing user-approved jobs. */
export function setupMergeProfiles(directory: string, bundledTask: string, model: string, harnesses: string[], benchmark?: { id: string; source: string }, catalog = BENCHMARKS, mcp?: McpSetup) {
  harnesses = selectMergeHarnesses(harnesses)
  const mcpNames = mcp ? harnesses.map(h => validateMcpServers(mcp.servers, h))[0] : undefined
  if (mcp?.envFile) { if (!mcpNames!.variables.length) throw new Error('--mcp-env is only needed when MCP headers reference ${NAME} variables.'); if (!existsSync(mcp.envFile)) throw new Error('The --mcp-env file does not exist.'); readMcpEnv(mcp.envFile, mcpNames!.variables) }
  else if (mcpNames?.variables.length) throw new Error(`MCP headers reference ${mcpNames.variables.join(', ')}. Pass --mcp-env with a file that sets them.`)
  const mcpSuffix = mcp ? `-mcp-${sha256(JSON.stringify(mcp.servers)).slice(0, 8)}` : ''
  const connection = mergeStatus(directory)
  if (!connection.connected || !connection.models.includes(model)) throw new Error('Connect Merge first and choose a model listed by provider status.')
  const path = initializeProfiles(directory, bundledTask)
  const registry = readJson<{ schemaVersion: number; profiles: Descriptor[] }>(path)
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.profiles)) throw new Error('Invalid existing profile registry.')
  const entry = benchmark && installBenchmark(directory, benchmark.id, benchmark.source, catalog)
  // Preserve existing CLI profile names while allowing additional models per harness.
  const idFor = (harness: string) => {
    if (entry) return `${entry.id}-${harness}-${sha256(model).slice(0, 8)}${mcpSuffix}`
    if (mcp) return `merge-${harness}-${sha256(model).slice(0, 8)}${mcpSuffix}`
    const legacy = registry.profiles.find(p => p.id === `merge-${harness}`)
    if (!legacy) return `merge-${harness}`
    const config = readJson<{ agents?: { model_name?: string }[] }>(resolve(directory, legacy.config))
    return config.agents?.[0]?.model_name === model ? legacy.id : `merge-${harness}-${sha256(model).slice(0, 8)}`
  }
  const tasks = entry ? entry.taskHashes!.map(([task]) => ({ path: `benchmarks/${entry.id}/${task}` })) : [{ path: 'tasks/heval-setup' }]
  const configFor = (harness: string) => ({ n_attempts: 1, agents: [{ name: harness, model_name: model, ...(mcp ? { mcp_servers: mcp.servers } : {}) }], tasks })
  const mcpTitle = mcpNames ? ` + MCP: ${mcpNames.names.join(', ')}` : ''
  for (const harness of harnesses) {
    const id = idFor(harness), existing = registry.profiles.find(p => p.id === id), config = join(directory, `${id}.json`)
    if (existing || existsSync(config)) {
      if (!existing || existing.provider !== 'merge' || existing.config !== `${id}.json` || !existsSync(config) || JSON.stringify(readJson(config)) !== JSON.stringify(configFor(harness))) throw new Error(`${id} already exists with different settings; review it before replacing it.`)
    }
  }
  for (const harness of harnesses) {
    const id = idFor(harness)
    if (registry.profiles.some(p => p.id === id)) continue
    writeJson(join(directory, `${id}.json`), configFor(harness))
    const env = mcp?.envFile ? { mcpEnvFile: mcp.envFile } : {}
    registry.profiles.push(entry
      ? { id, title: `${entry.title}: ${harness} / ${model}${mcpTitle}`, benchmark: entry.title, config: `${id}.json`, provider: 'merge', timeoutSeconds: entry.timeoutSeconds ?? 3600, ...env }
      : { id, title: `Merge smoke: ${harness}${mcpTitle}`, benchmark: 'OpenEval model connection smoke test', config: `${id}.json`, provider: 'merge', timeoutSeconds: 600, ...env })
  }
  writeJson(path, registry)
  return harnesses.map(idFor)
}
export function snapshotProfile(profile: LocalProfile, directory: string) {
  const tasks = profile.taskPaths.map((path, index) => {
    const target = join(directory, 'tasks', String(index + 1), basename(path))
    cpSync(path, target, { recursive: true, filter: name => !name.split('/').some(part => part === '.git' || part === '__pycache__') })
    const snapshot = fingerprintDirectory(target), expected = profile.taskExecutionMetadata[index]
    if (snapshot.contentHash !== profile.taskHashes[index] || snapshot.executionMetadata.version !== expected.version || snapshot.executionMetadata.digest !== expected.digest) throw new Error('Task contents or execution metadata changed while creating the run. Review the updated profile and start again.')
    return { path: target }
  })
  const config = { ...profile.config, tasks, job_name: 'evaluation', jobs_dir: join(directory, 'jobs') }
  writeJson(join(directory, 'harbor.json'), config)
}

/** The browser may vary attempts only inside the worker's explicit approval. */
export function requestedProfile(profile: LocalProfile, attempts?: number, settings?: RunSettings): LocalProfile {
  executionTimeoutSeconds(profile.public, attempts, settings)
  return { ...profile, config: { ...profile.config, n_attempts: attempts ?? profile.public.attempts,
    ...(settings ? { n_concurrent_trials: settings.concurrency, retry: { max_retries: settings.retries },
      environment: { ...object(profile.config.environment),
        ...(settings.cpus !== undefined ? { override_cpus: settings.cpus } : {}),
        ...(settings.memoryMb !== undefined ? { override_memory_mb: settings.memoryMb } : {}) } } : {}) } }
}
