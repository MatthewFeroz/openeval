import { createHash } from 'node:crypto'

/**
 * What an MCP server reported about itself when a run started. Remote servers
 * can change between runs, so each run records its own snapshot: the server's
 * self-reported name and version, its tool names, and a hash of the full tool
 * definitions (names, descriptions and input schemas) that the agent sees.
 */
export type McpSnapshot = {
  name: string
  transport: string
  status: 'ok' | 'error' | 'not-probed'
  server?: { name: string; version: string }
  protocolVersion?: string
  tools?: string[]
  /** First 12 hex characters of SHA-256 over the sorted tool definitions. */
  toolsHash?: string
  /** What the agent is told about each tool: first line of its description and its parameter names. */
  details?: { name: string; description: string; params: string[]; required: string[] }[]
  error?: string
}
type Server = { name: string; transport?: string; url?: string; headers?: Record<string, string> }
type Json = Record<string, unknown>

const PROTOCOL = '2025-06-18'
const reference = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const text = (value: unknown, max = 120) => typeof value === 'string' ? [...value].map(c => c.charCodeAt(0) < 32 ? ' ' : c).join('').trim().slice(0, max) : ''

/** Parse a JSON-RPC response from a JSON body or an SSE stream body. */
function messages(body: string, contentType: string): Json[] {
  if (contentType.includes('text/event-stream')) {
    return body.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      try { return data ? [JSON.parse(data) as Json] : [] } catch { return [] }
    })
  }
  const parsed = JSON.parse(body) as Json | Json[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** Streamable HTTP: one POST per request, with an optional session header. */
async function streamable(url: string, headers: Record<string, string>, signal: AbortSignal) {
  let session: string | undefined
  let id = 0
  const send = async (method: string, params: Json, notification = false) => {
    const res = await fetch(url, { method: 'POST', signal, redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}), ...(id > 1 ? { 'MCP-Protocol-Version': PROTOCOL } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notification ? {} : { id: ++id }) }) })
    session = res.headers.get('mcp-session-id') ?? session
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`)
    if (notification) { await res.body?.cancel(); return {} }
    const reply = messages(await res.text(), res.headers.get('content-type') ?? '').find(message => message.id === id)
    if (!reply) throw new Error(`No reply to ${method}`)
    if (reply.error) throw new Error(`${method} failed: ${text((reply.error as Json).message)}`)
    return reply.result as Json
  }
  const close = async () => { if (session) await fetch(url, { method: 'DELETE', signal, headers: { ...headers, 'Mcp-Session-Id': session } }).catch(() => undefined) }
  return { send, close }
}

/** Legacy SSE: requests are POSTed to an endpoint the event stream announces; replies arrive on the stream. */
async function sse(url: string, headers: Record<string, string>, signal: AbortSignal) {
  const res = await fetch(url, { signal, redirect: 'error', headers: { ...headers, Accept: 'text/event-stream' } })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} opening the event stream`)
  const reader = res.body.getReader(), decoder = new TextDecoder()
  let buffer = '', endpoint: string | undefined
  const pending = new Map<number, (message: Json) => void>()
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) {
        const lines = event.split(/\r?\n/)
        const kind = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message'
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (kind === 'endpoint') endpoint = new URL(data, url).toString()
        else try { const message = JSON.parse(data) as Json; pending.get(message.id as number)?.(message) } catch { /* not JSON-RPC */ }
      }
    }
  })().catch(() => undefined)
  while (!endpoint) { if (signal.aborted) throw new Error('Timed out waiting for the SSE endpoint'); await new Promise(done => setTimeout(done, 50)) }
  let id = 0
  const send = async (method: string, params: Json, notification = false) => {
    const current = notification ? undefined : ++id
    const reply = current === undefined ? undefined : new Promise<Json>(done => pending.set(current, done))
    const post = await fetch(endpoint!, { method: 'POST', signal, redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(current === undefined ? {} : { id: current }) }) })
    if (!post.ok) throw new Error(`HTTP ${post.status} for ${method}`)
    if (!reply) return {}
    const message = await reply
    if (message.error) throw new Error(`${method} failed: ${text((message.error as Json).message)}`)
    return message.result as Json
  }
  const close = async () => { await reader.cancel().catch(() => undefined); await pump }
  return { send, close }
}

async function probe(server: Server, env: Record<string, string>, timeoutMs: number): Promise<McpSnapshot> {
  const transport = server.transport === 'http' ? 'streamable-http' : server.transport ?? 'sse'
  const base = { name: server.name, transport }
  if (transport === 'stdio') return { ...base, status: 'not-probed', error: 'stdio servers start inside the task container' }
  const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([key, value]) => [key, value.replace(reference, (_, name: string) => env[name] ?? '')]))
  const signal = AbortSignal.timeout(timeoutMs)
  let client: Awaited<ReturnType<typeof streamable>> | undefined
  try {
    client = transport === 'sse' ? await sse(server.url!, headers, signal) : await streamable(server.url!, headers, signal)
    const init = await client.send('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'openeval-runner', version: '1' } })
    await client.send('notifications/initialized', {}, true)
    const tools: Json[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await client.send('tools/list', cursor ? { cursor } : {})
      if (Array.isArray(result.tools)) tools.push(...result.tools as Json[])
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
      if (!cursor) break
    }
    const info = (init.serverInfo ?? {}) as Json
    const definitions = tools.map(tool => ({ name: tool.name, description: tool.description ?? null, inputSchema: tool.inputSchema ?? null })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    return {
      ...base, status: 'ok',
      server: { name: text(info.name) || 'unknown', version: text(info.version, 64) || 'unknown' },
      ...(typeof init.protocolVersion === 'string' ? { protocolVersion: text(init.protocolVersion, 32) } : {}),
      tools: definitions.map(tool => text(tool.name, 128)).slice(0, 200),
      toolsHash: createHash('sha256').update(JSON.stringify(definitions)).digest('hex').slice(0, 12),
      details: definitions.slice(0, 100).map(tool => {
        const schema = tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema) ? tool.inputSchema as Json : {}
        const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties as Json : {}
        const params = Object.keys(properties).slice(0, 20).map(name => text(name, 64))
        const required = Array.isArray(schema.required) ? (schema.required as unknown[]).map(name => text(name, 64)).filter(name => params.includes(name)) : []
        return { name: text(tool.name, 128), description: text(String(tool.description ?? '').trim().split('\n')[0], 300), params, required }
      }),
    }
  } catch (error) {
    // Never echo headers or URLs: either can carry credentials.
    return { ...base, status: 'error', error: signal.aborted ? 'timed out' : text((error as Error).message, 160) || 'unreachable' }
  } finally { await client?.close().catch(() => undefined) }
}

/** Snapshot every configured server. A failed probe is recorded, not fatal: the agent may still reach it. */
export function probeMcpServers(servers: Server[], env: Record<string, string>, timeoutMs = 20_000): Promise<McpSnapshot[]> {
  return Promise.all(servers.map(server => probe(server, env, timeoutMs)))
}

/** One short line per server, e.g. `context7: Context7 1.2.3, 2 tools #3f9a2c1b4d5e`. */
export function describeSnapshots(snapshots: McpSnapshot[]): string {
  return snapshots.map(s => s.status === 'ok'
    ? `${s.name}: ${s.server!.name} ${s.server!.version}, ${s.tools!.length} ${s.tools!.length === 1 ? 'tool' : 'tools'} #${s.toolsHash}`
    : `${s.name}: ${s.status === 'not-probed' ? 'not probed (stdio)' : `probe failed (${s.error})`}`).join('; ').slice(0, 256)
}
