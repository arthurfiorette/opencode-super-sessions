import { type Ref, type RefSource, type RefStatus, refFromKey, refKey } from '../refs/ref.js';
import { sidebarRefs, workLinks } from '../refs/summary.js';
import { LINK_PROVIDER_NAMES, type LinkInfo, linkFromKey } from '../refs/work-link.js';
import type { SessionRefView } from '../rpc.js';
import { refLabel } from './links.js';

// How the agent reads a session's tracked work: the list that ends every link_work and
// unlink_work result, and the notice of links the agent did not make itself.

/** `PR acme/widgets#12` or `issue acme/widgets#7`. */
export function describeRef(ref: Ref): string {
  return `${ref.kind === 'pr' ? 'PR' : 'issue'} ${refLabel(ref)}`;
}

/** `Linear COR-1466`, or `link example.com` for a page no tracker claims. */
export function describeLink(info: LinkInfo): string {
  return `${LINK_PROVIDER_NAMES[info.provider]} ${info.name ?? info.url}`;
}

/** One tracked pull request, issue or work link, as the agent reads it. */
export interface LinkedItem {
  key: string;
  /** `PR acme/widgets#12`, `Linear COR-1466`. */
  label: string;
  /** The label, then its state and origin in parentheses, then its title when known. */
  line: string;
}

/**
 * Where a tracked item came from. The agent reads it to tell its own links from detection's and
 * the user's, and to spot one that does not belong. Worded without "you", which an agent that
 * lost the turn to a compaction or a subagent cannot confirm.
 */
const ORIGIN: Record<Exclude<RefSource, 'mention' | 'closes'>, string> = {
  agent: 'linked with link_work',
  created: 'created in this session',
  manual: 'the user linked it in the session list',
  prompt: 'from a user message'
};

/** States as the agent reads them; issue reasons are GitHub's words. */
const STATUS: Partial<Record<RefStatus, string>> = {
  completed: 'closed as completed',
  not_planned: 'closed as not planned'
};

/**
 * Everything the session tracks: pull requests in the rows' order, then issues, then work links.
 * Mentions are left out, as on the rows.
 */
export function linkedItems(view: SessionRefView): LinkedItem[] {
  const links = new Map(view.links.map((link) => [refKey(link.ref), link]));
  const refs = sidebarRefs(view).refs.map((ref): LinkedItem => {
    const key = refKey(ref);
    const link = links.get(key);
    const state = view.states[key];
    // A mentioned ref is listed only as a branch pull request.
    const origin =
      link === undefined || link.source === 'mention'
        ? "on this session's branch"
        : link.source === 'closes'
          ? closedBy(view, link.via)
          : ORIGIN[link.source];
    const status = state === undefined ? undefined : (STATUS[state.status] ?? state.status);
    const details = [status, origin].filter(Boolean).join(', ');
    return {
      key,
      label: describeRef(ref),
      line: `${describeRef(ref)} (${details})${state ? `: ${state.title}` : ''}`
    };
  });
  const work = workLinks(view).map(
    (link): LinkedItem => ({
      key: link.key,
      label: describeLink(link),
      // The URL is what unlink_work takes for a page outside the forges.
      line: `${describeLink(link)} ${link.url} (${ORIGIN[link.source]})${link.title ? `: ${link.title}` : ''}`
    })
  );
  return [...refs, ...work];
}

/** `linked PR acme/widgets#12 closes it`, naming the pull request a `closes` link came through. */
function closedBy(view: SessionRefView, via: string | undefined): string {
  const pr = [...view.branchRefs, ...view.links.map((link) => link.ref)].find(
    (ref) => refKey(ref) === via
  );
  return `${pr === undefined ? 'a linked pull request' : `linked ${describeRef(pr)}`} closes it`;
}

/**
 * The list that ends every link_work and unlink_work result, then what was unlinked: an agent
 * that lost the turn where the user dropped something would otherwise link it again, and its
 * explicit link brings it back.
 */
export function linkedList(view: SessionRefView | undefined, dismissed: readonly string[]): string {
  const items = view === undefined ? [] : linkedItems(view);
  const lines =
    items.length === 0
      ? ['Nothing is linked to this session.']
      : ['Everything linked to this session:', ...items.map((item) => `- ${item.line}`)];
  if (dismissed.length > 0) {
    lines.push(`Unlinked from this session: ${dismissed.map(dismissedLabel).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * How an unlinked key reads: `issue acme/widgets#12` for a forge ref, `Linear acme/COR-1` for a
 * work link, the key itself for anything else.
 */
function dismissedLabel(key: string): string {
  const ref = refFromKey(key);
  if (ref !== undefined) return describeRef(ref);
  const link = linkFromKey(key);
  return link === undefined ? key : `${LINK_PROVIDER_NAMES[link.provider]} ${link.id}`;
}
