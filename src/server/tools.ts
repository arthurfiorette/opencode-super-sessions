import type { Plugin } from '@opencode/plugin';
import { z } from 'zod';
import type { RefCandidate, RepoRef } from '../providers/provider.js';
import {
  type Ref,
  type RefSource,
  readSessionRefs,
  refKey,
  type SessionRefs,
  type WorkLink
} from '../refs/ref.js';
import { dismissLink, mergeLinks, mergeWorkLinks, type RefsUpdate } from '../refs/store.js';
import { LINK_PROVIDER_NAMES, type LinkInfo, recognizeLink } from '../refs/work-link.js';
import {
  linksOf,
  parseReference,
  type Resolution,
  reasonText,
  refLabel,
  resolveCandidates,
  resolveRepo,
  usableRefs
} from './links.js';
import type { Runtime } from './runtime.js';

const LINK_DESCRIPTION =
  'Record a pull request, issue or other piece of work this session works on so the user can ' +
  'track it in their session list. Changes nothing on GitHub, GitLab or any tracker. Call it ' +
  'when you start on an issue, when you open or find the pull request for your work, and when ' +
  'you switch to another one. Pass full URLs when you have them; a bare number uses the ' +
  'repository of the current directory. Any other web page is accepted too, such as a Linear, ' +
  'Jira, Azure Boards, Sentry, Notion, Trello, ClickUp, Shortcut or Asana item or a Slack ' +
  'thread; give its title when you know it.';

const UNLINK_DESCRIPTION =
  'Stop tracking a pull request, issue or other link in this session, for example one linked ' +
  'by mistake or work you dropped. Changes nothing on GitHub, GitLab or any tracker, and the ' +
  'link is not added again automatically.';

const urlText = z
  .string()
  .min(1)
  .max(2000)
  .describe('Pull request, issue or other work URL, or `owner/repo#123`.');
const url = z.strictObject({ url: urlText });
const titledUrl = z.strictObject({
  url: urlText,
  title: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe(
      'Title of the work at a URL that is not a GitHub or GitLab pull request or issue, as you know it.'
    )
});
const number = z.number().int().positive().describe('Pull request or issue number.');
const repo = z
  .string()
  .min(1)
  .optional()
  .describe('`owner/repo`. Defaults to the repository of the current directory.');

const linkInput = z.strictObject({
  refs: z
    .array(
      z.union([
        titledUrl,
        z.strictObject({
          number,
          repo,
          kind: z
            .enum(['pr', 'issue'])
            .optional()
            .describe('Whether it is a pull request or an issue. Looked up when omitted.')
        })
      ])
    )
    .min(1)
    .max(10)
});

const unlinkInput = z.strictObject({
  refs: z
    .array(z.union([url, z.strictObject({ number, repo })]))
    .min(1)
    .max(10)
});

type Item = z.output<typeof linkInput>['refs'][number];

// Trackers whose URLs a prompt links on its own (see `trackerLinks`).
const TRACKERS =
  'Linear, Jira, Azure Boards, Sentry, Notion, Slack, Trello, ClickUp, Shortcut or Asana';
// The rule for work outside the forges, which needs no forge and no prompt detection.
const ELSEWHERE =
  'when the work is tracked somewhere else, such as a Jira or Linear issue, an Azure Boards ' +
  'work item, a Sentry error or a Slack thread';
const PASS = 'pass its URL and the title you know.';

// What detection already links, so the agent calls link_work only for what it cannot see. Without
// it the agent re-links refs from the prompt and believes it forgot them. Keyed by whether GitHub
// or GitLab is enabled and whether "Record refs from prompts" is on.
const INSTRUCTIONS = {
  forgesPrompts:
    `Pull request and issue links in user messages, ${TRACKERS} links in user messages, the ` +
    'pull request of a branch you push with git push, and pull requests or issues you create ' +
    'with gh or glab are tracked automatically. You MUST call link_work when you start working ' +
    'on an issue or pull request that the user did not link, for example one you found by ' +
    `searching, when you open a pull request by any other means, and ${ELSEWHERE} the user did ` +
    `not paste: ${PASS} Do not call it for links the user already gave.`,
  forges:
    'The pull request of a branch you push with git push, and pull requests or issues you create ' +
    'with gh or glab are tracked automatically. You MUST call link_work when you start working ' +
    'on an issue or pull request, including one the user named, when you open a pull request by ' +
    `any other means, and ${ELSEWHERE}: ${PASS}`,
  prompts:
    `${TRACKERS} links in user messages are tracked automatically. You MUST call link_work ` +
    `${ELSEWHERE} the user did not paste: ${PASS} Do not call it for links the user already gave.`,
  none: `You MUST call link_work ${ELSEWHERE}: ${PASS}`
};

/**
 * Tells the agent what the plugin tracks on its own, through the `context` hook the host itself
 * uses for its tool instructions (packages/core/src/tool/plugin/opencode.ts:102 in OpenCode
 * v2.2.5). The hook runs once per model request on a system array rebuilt for each step, so the
 * part never piles up. Read at request time, so the settings dialog applies at once. Work links
 * need no forge, so the part stays when no forge is enabled.
 */
export async function registerInstructions(
  runtime: Runtime,
  context: Plugin.Context
): Promise<void> {
  await context.session.hook('context', (event) => {
    const forges = runtime.definitions.length > 0;
    const prompts = runtime.options.detect.prompts;
    const text = forges
      ? prompts
        ? INSTRUCTIONS.forgesPrompts
        : INSTRUCTIONS.forges
      : prompts
        ? INSTRUCTIONS.prompts
        : INSTRUCTIONS.none;
    event.system.push({ type: 'text', text });
  });
}

/** Registers `link_work` and `unlink_work` for one Location. */
export async function registerTools(runtime: Runtime, context: Plugin.Context): Promise<void> {
  await context.tool.transform((editor) => {
    editor.add({
      name: 'link_work',
      description: LINK_DESCRIPTION,
      input: linkInput,
      // Linking is a single bookkeeping call; batching it through Code Mode gains nothing.
      options: { codemode: false },
      execute: async (input, tool) => ({
        content: await linkWork(runtime, context, tool.sessionID, input.refs)
      })
    });
    editor.add({
      name: 'unlink_work',
      description: UNLINK_DESCRIPTION,
      input: unlinkInput,
      options: { codemode: false },
      execute: async (input, tool) => ({
        content: await unlinkWork(runtime, context, tool.sessionID, input.refs)
      })
    });
  });
}

/**
 * Turns a tool item into a forge candidate, a work link for a URL no forge reads, or explains
 * why it can be neither.
 */
function candidateOf(
  runtime: Runtime,
  item: Item,
  base: RepoRef | undefined
): RefCandidate | { link: LinkInfo } | string {
  if ('url' in item) {
    const candidate = parseReference(runtime.definitions, item.url, base);
    if (candidate !== undefined) return candidate;
    const link = recognizeLink(item.url);
    return link === undefined ? `Could not read ${item.url}: pass a web URL.` : { link };
  }
  if (item.repo === undefined && base === undefined) {
    return `#${item.number} needs a repository: the current directory has no GitHub or GitLab remote. Pass a URL or repo.`;
  }
  const text = item.repo === undefined ? `#${item.number}` : `${item.repo}#${item.number}`;
  const candidate = parseReference(runtime.definitions, text, base);
  if (candidate === undefined) return `Could not read ${text}.`;
  if ('kind' in item && item.kind !== undefined) return { ...candidate, kind: item.kind };
  // The `#` above is only syntax, but GitLab reads `#N` as an issue: the item named no kind.
  const { kind: _parsed, ...unknown } = candidate;
  return unknown;
}

/** Repository of the session's directory. The session may live in another Location's directory. */
async function sessionBase(
  runtime: Runtime,
  context: Plugin.Context,
  sessionID: string
): Promise<RepoRef | undefined> {
  const info = await context.session.get({ sessionID });
  return (await resolveRepo(runtime, info.location.directory)).repo;
}

/** `PR acme/widgets#12` or `issue acme/widgets#7`. */
function describe(ref: Ref): string {
  return `${ref.kind === 'pr' ? 'PR' : 'issue'} ${refLabel(ref)}`;
}

/**
 * How a line starts for a ref the session already tracked before this call, naming where the
 * link came from so the agent learns detection did it. Mentions are only counted, not tracked,
 * so linking one reads as a new link.
 */
const ALREADY: Partial<Record<RefSource, string>> = {
  prompt: "Already linked from the user's message:",
  created: 'Already linked when you created it:',
  manual: 'Already linked by the user:',
  agent: 'Already linked:',
  closes: 'Already linked through the pull request that closes it:'
};

/** One result line per resolution. `previous` is the ref's source before this call. */
function linkLine(resolution: Resolution, previous: (ref: Ref) => RefSource | undefined): string {
  const verb = (ref: Ref) => {
    const source = previous(ref);
    return (source && ALREADY[source]) ?? 'Linked';
  };
  switch (resolution.status) {
    case 'found':
      return `${verb(resolution.ref)} ${describe(resolution.ref)} (${resolution.state.status}): ${resolution.state.title}`;
    case 'unverified':
      return `${verb(resolution.ref)} ${describe(resolution.ref)}, but could not check it: ${reasonText(resolution.reason)}.`;
    case 'not-found':
      return `Not linked: ${refLabel(resolution.candidate)} does not exist or is not visible to the forge CLI.`;
    case 'unknown':
      return `Not linked: could not check ${refLabel(resolution.candidate)}: ${reasonText(resolution.reason)}. Pass its URL instead.`;
  }
}

/** Implements `link_work`: explicit agent links, which also undo an earlier dismissal. */
async function linkWork(
  runtime: Runtime,
  context: Plugin.Context,
  sessionID: string,
  items: Item[]
): Promise<string> {
  const base = await sessionBase(runtime, context, sessionID);
  const parsed = items.map((item) => ({ item, found: candidateOf(runtime, item, base) }));
  const candidates = parsed.flatMap(({ found }) =>
    typeof found === 'string' || 'link' in found ? [] : [found]
  );
  const work = parsed.flatMap(({ item, found }) =>
    typeof found !== 'string' && 'link' in found
      ? [{ info: found.link, title: 'title' in item ? item.title : undefined }]
      : []
  );
  const resolutions = await resolveCandidates(runtime, candidates);
  const links = linksOf(usableRefs(resolutions), 'agent');
  const linkedAt = Date.now();
  const workLinks = work.map(
    ({ info, title }): WorkLink => ({
      url: info.url,
      source: 'agent',
      linkedAt,
      ...(title === undefined ? {} : { title })
    })
  );
  // Read inside the queued write, so a link detection added a moment ago still counts as earlier.
  const sources = new Map<string, RefSource>();
  if (links.length > 0 || workLinks.length > 0) {
    await runtime.writes.update(context.session, sessionID, (refs) => {
      for (const link of refs.links) sources.set(refKey(link.ref), link.source);
      for (const link of refs.urls ?? []) {
        const key = recognizeLink(link.url)?.key;
        if (key !== undefined) sources.set(key, link.source);
      }
      // `agent` is an explicit source, so both merges lift any earlier dismissal of these keys.
      const merged = mergeLinks(refs, links);
      const added = mergeWorkLinks(merged.next, workLinks);
      return { next: added.next, changed: merged.changed || added.changed };
    });
  }
  const previous = (ref: Ref) => sources.get(refKey(ref));
  const errors = parsed.flatMap(({ found }) => (typeof found === 'string' ? [found] : []));
  return [
    ...resolutions.map((resolution) => linkLine(resolution, previous)),
    ...work.map(({ info, title }) => {
      const source = sources.get(info.key);
      const named = title ?? info.title;
      return `${(source && ALREADY[source]) ?? 'Linked'} ${describeLink(info)}${named ? `: ${named}` : ''}`;
    }),
    ...errors
  ].join('\n');
}

/** `Linear COR-1466`, or `link example.com` for a page no tracker claims. */
function describeLink(info: LinkInfo): string {
  return `${LINK_PROVIDER_NAMES[info.provider]} ${info.name ?? info.url}`;
}

/** Whether a stored ref is the one a candidate names; kind only counts when the candidate has one. */
function names(candidate: RefCandidate, ref: Ref): boolean {
  return (
    ref.provider === candidate.provider &&
    ref.host.toLowerCase() === candidate.host.toLowerCase() &&
    ref.repo.toLowerCase() === candidate.repo.toLowerCase() &&
    ref.number === candidate.number &&
    (candidate.kind === undefined || ref.kind === candidate.kind)
  );
}

/** Implements `unlink_work`: dismisses each ref so detection does not add it back. */
async function unlinkWork(
  runtime: Runtime,
  context: Plugin.Context,
  sessionID: string,
  items: Item[]
): Promise<string> {
  const info = await context.session.get({ sessionID });
  const base = (await resolveRepo(runtime, info.location.directory)).repo;
  const current = readSessionRefs(info.metadata);
  const lines: string[] = [];
  const keys: string[] = [];

  const pending: RefCandidate[] = [];
  for (const item of items) {
    const candidate = candidateOf(runtime, item, base);
    if (typeof candidate === 'string') {
      lines.push(candidate);
      continue;
    }
    if ('link' in candidate) {
      // Dismissed even when not linked yet, so a prompt does not add it later.
      keys.push(candidate.link.key);
      lines.push(`Unlinked ${describeLink(candidate.link)}.`);
      continue;
    }
    const matched = current.links.filter((link) => names(candidate, link.ref));
    if (matched.length > 0) {
      for (const link of matched) {
        keys.push(refKey(link.ref));
        lines.push(`Unlinked ${describe(link.ref)}.`);
      }
      continue;
    }
    // Not linked yet: dismissing it still stops detection (or the branch) from adding it.
    if (candidate.kind !== undefined) {
      const ref = { ...candidate, kind: candidate.kind };
      keys.push(refKey(ref));
      lines.push(`Unlinked ${describe(ref)}.`);
      continue;
    }
    pending.push(candidate);
  }

  for (const resolution of await resolveCandidates(runtime, pending)) {
    if (resolution.status === 'found' || resolution.status === 'unverified') {
      keys.push(refKey(resolution.ref));
      lines.push(`Unlinked ${describe(resolution.ref)}.`);
    } else {
      lines.push(`Not unlinked: ${refLabel(resolution.candidate)} is not linked to this session.`);
    }
  }

  if (keys.length > 0) {
    await runtime.writes.update(context.session, sessionID, (refs) => dismissAll(refs, keys));
  }
  return lines.join('\n');
}

/** Dismisses several keys in one update. */
function dismissAll(refs: SessionRefs, keys: string[]): RefsUpdate {
  let next = refs;
  let changed = false;
  for (const key of keys) {
    const update = dismissLink(next, key);
    next = update.next;
    changed ||= update.changed;
  }
  return { next, changed };
}
