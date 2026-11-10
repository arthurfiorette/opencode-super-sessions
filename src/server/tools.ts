import type { Plugin } from '@opencode/plugin';
import { z } from 'zod';
import type { RefCandidate, RepoRef } from '../providers/provider.js';
import { parseUrl } from '../providers/registry.js';
import {
  type ProviderId,
  type Ref,
  type RefSource,
  readSessionRefs,
  refKey,
  type SessionRefs,
  type WorkLink
} from '../refs/ref.js';
import { dismissLink, mergeLinks, mergeWorkLinks, type RefsUpdate } from '../refs/store.js';
import {
  cleanTitle,
  LINK_PROVIDER_NAMES,
  type LinkInfo,
  recognizeLink
} from '../refs/work-link.js';
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

const FORGE_NAMES: Record<ProviderId, string> = { github: 'GitHub', gitlab: 'GitLab' };

// When to call link_work is said once, in the system instruction below; the descriptions say
// what the tools take, so the two never repeat or disagree.
const LINK_DESCRIPTION =
  'Adds a pull request, issue, ticket or other work page to what the user sees for this ' +
  'session in their session list. Nothing changes on GitHub, GitLab or any tracker.';

const UNLINK_DESCRIPTION =
  'Removes work from what the user sees for this session, for example a mistaken link or work ' +
  'the user dropped. Nothing changes elsewhere. Automatic linking does not add it back; ' +
  'link_work does.';

const url = z.strictObject({
  url: z.string().min(1).max(2000).describe('The linked URL, or `owner/repo#123`.')
});
const titledUrl = z.strictObject({
  url: z.string().min(1).max(2000).describe('Any http(s) URL, or `owner/repo#123`.'),
  title: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe(
      'Pass it for a URL outside GitHub and GitLab: nothing fetches titles there, so the list shows what you pass.'
    )
});
const number = z.number().int().positive().describe('Pull request or issue number.');
const repo = z
  .string()
  .min(1)
  .optional()
  .describe("`owner/repo`. Defaults to the current directory's repository.");

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
            .describe('`pr` or `issue`. Looked up when omitted.')
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

// Pages a prompt links on its own (see `trackerLinks`). Named in full, since an agent told "and
// similar" cannot tell which pasted links still need a call.
const TRACKERS =
  'Linear, Jira, Azure Boards, Sentry, Notion, Slack, Trello, ClickUp, Shortcut or Asana pages';

/**
 * What detection already links, so the agent calls link_work only for what it cannot see.
 * Without it the agent re-links refs from the prompt and believes it forgot them. `forges` says
 * whether GitHub or GitLab is enabled, `prompts` whether "Record refs from prompts" is on.
 */
export function instructionText(forges: boolean, prompts: boolean): string {
  const automatic = [
    ...(prompts && forges
      ? ['GitHub or GitLab pull requests and issues in user messages, as links, owner/repo#N or #N']
      : []),
    ...(prompts ? [`links in user messages to ${TRACKERS}`] : []),
    ...(forges
      ? [
          'the pull request of a branch you push',
          'pull requests and issues you create with gh or glab'
        ]
      : [])
  ];
  const cases = [
    ...(prompts
      ? ['one you found yourself', 'a ticket the user named only by its id (OPS-12)']
      : []),
    ...(!prompts && forges ? ['one the user named'] : []),
    ...(forges ? ['a pull request you opened another way'] : [])
  ];
  const rule =
    `You MUST call link_work when you start on ${automatic.length > 0 ? 'any other' : 'an'} ` +
    `issue, pull request, ticket, error report or thread${cases.length > 0 ? `, including ${joined(cases)}` : ''}.`;
  return automatic.length > 0
    ? `Linked to this session automatically: ${automatic.join('; ')}. ${rule}`
    : rule;
}

/** `a`, `a and b`, or `a, b and c`. */
function joined(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

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
    const text = instructionText(runtime.definitions.length > 0, runtime.options.detect.prompts);
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
    // A pull request or issue of a forge that is turned off would become a plain link here, and
    // a second entry once the forge is on again.
    const disabled = parseUrl(item.url);
    if (disabled !== undefined) {
      return `Not linked: ${item.url} is on ${FORGE_NAMES[disabled.provider]}, which is not enabled.`;
    }
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
      ? [
          {
            info: found.link,
            title: 'title' in item && item.title ? cleanTitle(item.title) || undefined : undefined
          }
        ]
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
      const stored = (current.urls ?? []).some(
        (link) => recognizeLink(link.url)?.key === candidate.link.key
      );
      if (stored) {
        keys.push(candidate.link.key);
        lines.push(`Unlinked ${describeLink(candidate.link)}.`);
      } else {
        lines.push(`Not unlinked: ${describeLink(candidate.link)} is not linked to this session.`);
      }
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
