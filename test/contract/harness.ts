import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '@opencode/plugin';

/**
 * Throwaway home for one contract test file. `node --test` runs each file in its own process, so
 * the environment is replaced here, before the SDK is imported, and nothing reads or writes the
 * developer's real OpenCode config, credentials, database or sessions.
 */
export const root = mkdtempSync(path.join(tmpdir(), 'opencode-super-sessions-contract-'));
/** The `opencode` binary the TUI test starts, read before the scrub below drops the variable. */
export const OPENCODE_BIN = process.env.OPENCODE_BIN ?? 'opencode';
// Upper case, because Windows lists names as stored (`Path`, `ComSpec`).
const keep = ['PATH', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC', 'SHELL'];
for (const key of Object.keys(process.env)) {
  // Model keys and personal service settings would leak into the host otherwise.
  if (!keep.includes(key.toUpperCase())) delete process.env[key];
}
Object.assign(process.env, {
  TEMP: root,
  TMP: root,
  TMPDIR: root,
  HOME: root,
  USERPROFILE: root,
  APPDATA: path.join(root, 'appdata'),
  LOCALAPPDATA: path.join(root, 'localappdata'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_STATE_HOME: path.join(root, 'state'),
  XDG_CACHE_HOME: path.join(root, 'cache')
});
process.on('exit', () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

/** Model id the scripted provider serves; the host config selects it as the default model. */
export const MODEL = 'contract/scripted';
/** Title the scripted model returns to the host's title agent. */
export const GENERATED_TITLE = 'Scripted title';
/** Command the scripted model asks the shell tool to run, and what it prints. */
export const SHELL_COMMAND = 'echo contract-shell-output';
export const SHELL_OUTPUT = 'contract-shell-output';
/** Reasoning and final text the scripted model streams, so tests can find them in events and messages. */
export const REASONING = 'Thinking about the contract.';
export const ANSWER = 'Contract answer with https://github.com/acme/widgets/pull/34 in it.';

/** A chat completions request body, reduced to the fields the script branches on. */
interface ChatRequest {
  tools?: { function?: { name?: string } }[];
  messages?: { role?: string; content?: unknown }[];
}

/** What one agent-loop request sent to the scripted model. */
export interface AgentRequest {
  /** Text of every system message, in order. */
  system: string[];
}

/**
 * Starts an OpenAI-compatible chat completions endpoint on loopback that plays a fixed script, so
 * the host runs its real agent loop, tool registry and title agent without a model or network:
 * - a request without tools is the title agent and gets `GENERATED_TITLE`;
 * - the first step of a prompt gets reasoning and a `shell` tool call;
 * - the step after the tool result gets reasoning and the final text.
 * `requests` collects every agent-loop request (the ones that offer tools) as it arrives.
 */
export async function startScriptedModel(): Promise<{
  baseURL: string;
  requests: AgentRequest[];
  close(): Promise<void>;
}> {
  const requests: AgentRequest[] = [];
  const server = createServer((request, response) => {
    void respond(request, response, requests);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

/** Streams one scripted completion as server-sent events. */
async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  requests: AgentRequest[]
): Promise<void> {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw) as ChatRequest;
  if (body.tools?.length) {
    const system = (body.messages ?? []).filter((message) => message.role === 'system');
    // Chat messages carry a string or an array of text parts.
    requests.push({
      system: system.map((message) =>
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((part: { text?: string }) => part.text ?? '').join('')
            : ''
      )
    });
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (delta: object, finish: string | null = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-contract',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'scripted',
        choices: [{ index: 0, delta, finish_reason: finish }]
      })}\n\n`
    );
  const offersShell = body.tools?.some((tool) => tool.function?.name === 'shell') ?? false;
  const answered = body.messages?.some((message) => message.role === 'tool') ?? false;
  if (!offersShell) {
    send({ role: 'assistant', content: GENERATED_TITLE });
    send({}, 'stop');
  } else if (!answered) {
    send({ role: 'assistant', reasoning_content: REASONING });
    send({
      tool_calls: [
        {
          index: 0,
          id: 'call_contract',
          type: 'function',
          function: { name: 'shell', arguments: JSON.stringify({ command: SHELL_COMMAND }) }
        }
      ]
    });
    send({}, 'tool_calls');
  } else {
    // Reasoning first, so the answer is the second part but the first text part.
    send({ role: 'assistant', reasoning_content: REASONING });
    send({ content: ANSWER });
    send({}, 'stop');
  }
  response.write(
    `data: ${JSON.stringify({ id: 'chatcmpl-contract', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
  );
  response.end('data: [DONE]\n\n');
}

/**
 * Server config that makes the scripted endpoint the only provider and the default model for
 * both the agent and the title agent. The native OpenAI-compatible provider ships with the host,
 * so nothing is installed from npm.
 */
export function modelConfig(baseURL: string) {
  const [provider, model] = MODEL.split('/') as [string, string];
  return {
    model: MODEL,
    small_model: MODEL,
    providers: {
      [provider]: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL, apiKey: 'contract' },
        models: { [model]: {} }
      }
    }
  };
}

/**
 * Creates an in-process host with the scripted model as its default, `plugins` loaded in every
 * Location, and the built opencode-super-sessions server plugin from `dist/`. Its `gh` is a name
 * on no PATH, so detection never reaches GitHub with whatever login the machine has. The SDK is
 * imported here, after the environment above is in place.
 */
export async function createHost(baseURL: string, plugins: Plugin.Plugin[]) {
  const { OpenCode } = await import('@opencode/sdk');
  const config = path.join(root, 'opencode-config');
  mkdirSync(config, { recursive: true });
  const content = {
    ...modelConfig(baseURL),
    plugins: [
      {
        package: fileURLToPath(new URL('../../', import.meta.url)),
        options: { ghPath: 'gh-contract-missing', glabPath: 'glab-contract-missing' }
      }
    ]
  };
  return OpenCode.create({
    database: { path: ':memory:' },
    config: { directory: config, project: false, content: JSON.stringify(content) },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    plugins
  });
}

/** Creates an empty directory under the test root, for a session Location. */
export function directory(...segments: string[]): string {
  const target = path.join(root, ...segments);
  mkdirSync(target, { recursive: true });
  return target;
}

/** Polls `read` until `accepts` holds, failing after 20 seconds with the last value. */
export async function until<T>(read: () => T | Promise<T>, accepts: (value: T) => boolean) {
  const deadline = Date.now() + 20_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accepts(last)) return last;
    await sleep(25);
  }
  throw new Error(`Condition not reached: ${JSON.stringify(last)}`);
}
