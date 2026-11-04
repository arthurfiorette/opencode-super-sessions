import type { Plugin } from '@opencode/plugin';
import { z } from 'zod';
import type { RefCandidate, RepoRef } from '../providers/provider.js';
import { type Ref, readSessionRefs, refKey, type SessionRefs } from '../refs/ref.js';
import { dismissLink, type RefsUpdate } from '../refs/store.js';
import {
  addLinks,
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
  'Record a pull request or issue this session works on so the user can track its status in ' +
  'their session list. Changes nothing on GitHub or GitLab. Call it when you start on an issue, when you ' +
  'open or find the pull request for your work, and when you switch to another one. Pass full ' +
  'URLs when you have them; a bare number uses the repository of the current directory.';

const UNLINK_DESCRIPTION =
  'Stop tracking a pull request or issue in this session, for example one linked by mistake or ' +
  'work you dropped. Changes nothing on GitHub or GitLab, and the ref is not linked again automatically.';

const url = z.strictObject({
  url: z.string().min(1).describe('Pull request or issue URL, or `owner/repo#123`.')
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
        url,
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

/** Turns a tool item into a candidate, or explains why it cannot. */
function candidateOf(
  runtime: Runtime,
  item: Item,
  base: RepoRef | undefined
): RefCandidate | string {
  if ('url' in item) {
    return parseReference(runtime.definitions, item.url, base) ?? `Could not read ${item.url}.`;
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

/** One result line per resolution. */
function linkLine(resolution: Resolution): string {
  switch (resolution.status) {
    case 'found':
      return `Linked ${describe(resolution.ref)} (${resolution.state.status}): ${resolution.state.title}`;
    case 'unverified':
      return `Linked ${describe(resolution.ref)}, but could not check it: ${reasonText(resolution.reason)}.`;
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
  const parsed = items.map((item) => candidateOf(runtime, item, base));
  const candidates = parsed.filter((value) => typeof value !== 'string');
  const resolutions = await resolveCandidates(runtime, candidates);
  // `agent` is an explicit source, so mergeLinks lifts any earlier dismissal of these keys.
  await addLinks(runtime, context.session, sessionID, linksOf(usableRefs(resolutions), 'agent'));
  const errors = parsed.filter((value) => typeof value === 'string');
  return [...resolutions.map(linkLine), ...errors].join('\n');
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
