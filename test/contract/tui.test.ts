import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  ANSWER,
  directory,
  modelConfig,
  OPENCODE_BIN,
  root,
  startScriptedModel
} from './harness.js';

// The repository root resolves to both plugin entries through package.json `exports`, so the
// host loads the built `dist/` the same way it loads an installed package.
const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
// The browser's search placeholder; the built-in session list has no such text.
const BROWSER = 'Search sessions, #numbers';

// One launch covers every TUI assumption, because starting the real host is the slow part.
test('the real TUI hands session.list, the peek arrows and its dialogs to the plugin', {
  timeout: 120_000
}, async (t) => {
  // `after` hooks also run when the test fails or times out. A server or child left open keeps
  // this file's process alive, and `node --test` then waits on it forever.
  const model = await startScriptedModel();
  t.after(() => model.close());
  const tui = await launch(model.baseURL);
  t.after(() => tui.close());

  await tui.waitFor('Ask anything');
  await send(tui, 'alpha task');
  await tui.leader('n');
  await send(tui, 'beta task');

  // `<leader>l` is the host's `session.list` keybind; the browser only opens when the plugin's
  // priority layer wins the command over the built-in dialog.
  await tui.leader('l');
  await tui.waitFor(BROWSER);
  // The placeholder draws at mount, while the first list load is still in flight and nothing is
  // selected, so space has nothing to peek. The count comes from the same rows as the
  // selection, which is set in the same update.
  await tui.waitFor(/Active 2\s/);

  // The banner renders in the `session.composer.top` slot of the peeked session.
  await tui.press(' ');
  await tui.waitFor('Peeking 1 of 2');
  // With an empty prompt, the priority 2 peek layer must beat the prompt history layers.
  await tui.press('arrow_down');
  await tui.waitFor('Peeking 2 of 2');
  await tui.press('arrow_up');
  await tui.waitFor('Peeking 1 of 2');
  await tui.press('escape');
  const back = await tui.waitFor(BROWSER);
  assert.doesNotMatch(back, /Peeking/);

  // A host dialog must draw above the `app` slot overlay and take the typed keys.
  await tui.press('r', { ctrl: true });
  await tui.waitFor('Rename session');
  await tui.type(' renamed');
  await tui.call('ui.enter');
  await tui.waitFor('Scripted title renamed');

  // ctrl+p dispatches the host's palette command (COMMAND_PALETTE) from the browser's mode;
  // esc closes the palette and hands the keys back to the browser.
  // The palette's title row; the browser footer only says "commands" in lower case.
  const palette = /Commands\s+esc/;
  await tui.press('p', { ctrl: true });
  await tui.waitFor(palette);
  await tui.press('escape');
  const after = await tui.waitFor(BROWSER);
  assert.doesNotMatch(after, palette);
});

/** Sends a prompt from the composer and waits for the scripted answer. */
async function send(tui: Tui, text: string) {
  await tui.type(text);
  await tui.call('ui.enter');
  await tui.waitFor(ANSWER.slice(0, 20));
}

interface Tui {
  /** Sends one Drive request and resolves with its result. */
  call(method: string, params?: object): Promise<unknown>;
  type(text: string): Promise<unknown>;
  /** Presses a key: a character or an OpenTUI `KeyCodes` name such as `escape`. */
  press(key: string, modifiers?: { ctrl?: boolean }): Promise<unknown>;
  /** Presses ctrl+x, the host's default leader, then `key`, in one host task. */
  leader(key: string): Promise<unknown>;
  /** Polls the screen until it contains `text` and returns it, or fails with the last screen. */
  waitFor(text: string | RegExp): Promise<string>;
  close(): Promise<void>;
}

/**
 * Starts the `opencode` binary (`OPENCODE_BIN`, else the one on PATH) with a private server, the
 * Drive control socket and a headless renderer (packages/simulation/src/frontend/simulation.ts in
 * the OpenCode repository), so keys travel through the host's real keymap, slots and dialogs.
 * Drive is the host's own test harness, not a plugin API: if a release changes it, this test
 * fails for that reason and the compatibility issue must say so.
 */
async function launch(baseURL: string): Promise<Tui> {
  const port = await freePort();
  // Drive reads `<XDG_STATE_HOME>/opencode-drive/instances/<OPENCODE_DRIVE>.json`
  // (packages/simulation/src/manifest.ts).
  const instances = path.join(root, 'state', 'opencode-drive', 'instances');
  mkdirSync(instances, { recursive: true });
  writeFileSync(
    path.join(instances, 'contract.json'),
    JSON.stringify({
      endpoints: { ui: `ws://127.0.0.1:${port}`, backend: `ws://127.0.0.1:${await freePort()}` },
      viewport: { cols: 140, rows: 40 }
    })
  );
  const child = spawn(OPENCODE_BIN, ['--standalone'], {
    cwd: directory('tui-project'),
    env: {
      ...process.env,
      // The fresh home has no cached models.dev catalog, so the host fetches it at startup and
      // republishes every provider and model when it lands. Landing around the first Enter makes
      // the host drop that Enter (the prompt keeps its text, nothing reaches the model). The
      // in-process hosts in harness.ts turn the fetch off the same way (`models.fetch: false`;
      // the variable is read in packages/cli/src/server-process.ts).
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      // The update check is the other startup network call; a newer release would show a notice
      // over the screen the test reads (packages/cli/src/services/updater.ts).
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DRIVE: 'contract',
      OPENCODE_DRIVE_RENDERER: 'headless',
      OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: [PACKAGE] }),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [PACKAGE], ...modelConfig(baseURL) })
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  // A binary that cannot start emits `error` (ENOENT and the like) and never sets `exitCode`.
  child.once('error', (error) => {
    stderr += `\n${OPENCODE_BIN}: ${error.message}`;
  });
  let socket: WebSocket;
  try {
    socket = await connect(`ws://127.0.0.1:${port}`, child, () => stderr);
  } catch (error) {
    child.kill();
    throw error;
  }
  let next = 1;
  const pending = new Map<
    number,
    (message: { result?: unknown; error?: { message: string } }) => void
  >();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const call = (method: string, params?: object) =>
    new Promise<unknown>((resolve, reject) => {
      const id = next++;
      pending.set(id, (message) =>
        message.error
          ? reject(new Error(`${method}: ${message.error.message}`))
          : resolve(message.result)
      );
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  const screen = async () => {
    const capture = (await call('ui.capture')) as { lines: { spans: { text: string }[] }[] };
    return capture.lines.map((line) => line.spans.map((span) => span.text).join('')).join('\n');
  };
  const press = (key: string, modifiers: { ctrl?: boolean } = {}) =>
    call('ui.press', { key, modifiers });
  return {
    call,
    type: (text) => call('ui.type', { text }),
    press,
    // Two `ui.press` calls are two host tasks, and an update landing between them can drop the
    // leader: the session route rebuilds its keymap layers whenever its queued prompts change
    // (packages/tui/src/routes/session/index.tsx), and OpenTUI's keymap clears the whole pending
    // sequence when a layer holding part of it unregisters (@opentui/keymap
    // src/services/layers.ts). Right after a turn ends that happens within milliseconds, and
    // `key` then lands in the prompt. `ui.type` writes both bytes in one loop; 0x18 is ctrl+x.
    leader: (key) => call('ui.type', { text: `\x18${key}` }),
    async waitFor(text) {
      const deadline = Date.now() + 30_000;
      let last = '';
      while (Date.now() < deadline) {
        last = await screen();
        if (typeof text === 'string' ? last.includes(text) : text.test(last)) return last;
        await sleep(100);
      }
      throw new Error(
        `"${text}" never appeared. Screen:\n${last}\nstderr:\n${stderr.slice(-4000)}`
      );
    },
    async close() {
      socket.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  };
}

/** Opens the Drive socket, retrying while the TUI starts, and fails early if the TUI exits. */
async function connect(url: string, child: ChildProcess, stderr: () => string): Promise<WebSocket> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`opencode exited early:\n${stderr()}`);
    const socket = new WebSocket(url);
    const opened = await new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => resolve(true), { once: true });
      socket.addEventListener('error', () => resolve(false), { once: true });
    });
    if (opened) return socket;
    await sleep(200);
  }
  throw new Error(`The Drive socket never opened:\n${stderr()}`);
}

/** A loopback port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(address && typeof address === 'object');
  return address.port;
}
