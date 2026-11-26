import type { McpServerTools, RunnerProfile } from './protocol'
import { mcpLabel } from './protocol'
import { HARNESS } from '../harnesses'

function formatProbedAt(iso: string) {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function serverHeading(entry: McpServerTools) {
  const name = entry.server?.name && entry.server.name !== 'unknown' ? entry.server.name : entry.name
  const version = entry.server?.version && entry.server.version !== 'unknown' ? entry.server.version : ''
  return version ? `${name} ${version}` : name
}

function ServerCard({ name, entry }: { name: string; entry?: McpServerTools }) {
  if (!entry) {
    return <div className="mcp-server">
      <div className="mcp-server-head"><strong>{name}</strong><span>not probed</span></div>
      <p className="mcp-server-note">Tool list not recorded for this server yet.</p>
    </div>
  }
  if (entry.status === 'not-probed') {
    return <div className="mcp-server">
      <div className="mcp-server-head"><strong>{entry.name}</strong><span>stdio · not probed</span></div>
      <p className="mcp-server-note">{entry.error || 'stdio servers start inside the task container.'}</p>
    </div>
  }
  if (entry.status === 'error') {
    return <div className="mcp-server">
      <div className="mcp-server-head"><strong>{entry.name}</strong><span>probe failed</span></div>
      <p className="mcp-server-note mcp-server-error">Could not list tools: {entry.error || 'unreachable'}. The evaluation can still run if the task container can reach it.</p>
    </div>
  }
  const tools = entry.tools ?? []
  const meta = `${entry.name} · ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}${entry.toolsHash ? ` · #${entry.toolsHash}` : ''}`
  return <div className="mcp-server">
    <div className="mcp-server-head"><strong>{serverHeading(entry)}</strong><span>{meta}</span></div>
    {tools.length ? tools.map(tool => <div className="mcp-tool" key={tool.name}>
      <code>{tool.name}</code>
      {tool.description && <p>{tool.description}</p>}
      {tool.params.length > 0 && <small>{tool.params.map(param => tool.required.includes(param) ? param : `${param}?`).join(', ')}</small>}
    </div>) : <p className="mcp-server-note">This server reported no tools.</p>}
  </div>
}

/** Side-by-side preview of the MCP tools each selected setup exposes to the agent. */
export function McpToolList({ profiles, workerName }: { profiles: (RunnerProfile | undefined)[]; workerName?: string }) {
  const probedTimes = profiles.map(p => p?.mcpTools?.probedAt).filter((t): t is string => !!t).sort()
  const latestProbed = probedTimes.at(-1)
  const subtitle = latestProbed
    ? `Probed on ${workerName ?? 'worker'} · ${formatProbedAt(latestProbed)}`
    : profiles.some(p => p?.mcp?.length) ? 'Tool list not recorded yet' : undefined

  return <section className="mcp-map" aria-label="MCP tools the agent will see">
    <div className="mcp-map-head">
      <h4>MCP tools the agent will see</h4>
      {subtitle && <small>{subtitle}</small>}
    </div>
    <div className="mcp-cols">
      {profiles.map((profile, index) => {
        const heading = `${index === 0 ? 'First setup' : 'Second setup'}${profile ? ` · ${mcpLabel(profile)}` : ''}`
        if (!profile) {
          return <div className="mcp-col" key={index}>
            <h5>{heading}</h5>
            <p className="mcp-empty">Choose a configured MCP setup to inspect its tools.</p>
          </div>
        }
        if (!profile.mcp?.length) {
          return <div className="mcp-col" key={`${profile.id}:${index}`}>
            <h5>{heading}</h5>
            <p className="mcp-empty">No MCP servers. {HARNESS[profile.agent]?.name ?? profile.agent} uses only its built-in tools.</p>
          </div>
        }
        if (!profile.mcpTools) {
          return <div className="mcp-col" key={`${profile.id}:${index}`}>
            <h5>{heading}</h5>
            <p className="mcp-empty">Tool list not recorded yet. Restart your worker or run <code>openeval runner setup --mcp</code> to probe {profile.mcp.join(', ')}.</p>
          </div>
        }
        const byName = new Map(profile.mcpTools.servers.map(server => [server.name, server]))
        return <div className="mcp-col" key={`${profile.id}:${index}`}>
          <h5>{heading}</h5>
          {profile.mcp.map(serverName => <ServerCard key={serverName} name={serverName} entry={byName.get(serverName)} />)}
        </div>
      })}
    </div>
  </section>
}
