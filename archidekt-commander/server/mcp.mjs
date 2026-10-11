// Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0. Logs go to stderr only.

import readline from 'node:readline';
import { withCallScope } from './store.mjs';

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';

export function startMcpServer({ name, version, instructions, tools, log }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
      // Responses from the client (no method) are ignored; anything else is an invalid request.
      if (msg && typeof msg === 'object' && !Array.isArray(msg) && ('result' in msg || 'error' in msg)) return;
      return fail(msg && typeof msg === 'object' && !Array.isArray(msg) ? msg.id ?? null : null, -32600, 'Invalid Request');
    }
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    if (!isRequest) return; // notifications never get a response
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return reply(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
        });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, {
          tools: tools.map(({ name: n, description, inputSchema, annotations }) => ({
            name: n,
            description,
            inputSchema,
            ...(annotations ? { annotations } : {}),
          })),
        });
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
        let result;
        try {
          const text = await withCallScope(() => tool.handler(params.arguments || {}));
          result = { content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 1) }] };
        } catch (e) {
          if (!(e && e.kind)) log(`tool ${tool.name} crashed: ${e?.stack || e}`);
          result = { content: [{ type: 'text', text: `Erro: ${e?.message || String(e)}` }], isError: true };
        }
        return reply(id, result);
      }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  let inFlight = 0;
  let closed = false;
  const maybeExit = () => {
    if (closed && inFlight === 0) process.stdout.write('', () => process.exit(0)); // flush first (async pipes on Windows)
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    line = line.replace(/^\uFEFF/, ''); // BOM some Windows tools prepend to piped input
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) {
      inFlight++;
      Promise.resolve()
        .then(() => handle(m))
        .catch((e) => {
          log(`handler error: ${e?.stack || e}`);
          if (m && typeof m === 'object' && m.id !== undefined && m.id !== null) fail(m.id, -32603, 'Internal error');
        })
        .finally(() => {
          inFlight--;
          maybeExit();
        });
    }
  });
  // Let in-flight calls finish (and their responses flush) before exiting when stdin closes.
  rl.on('close', () => {
    closed = true;
    maybeExit();
  });
}
