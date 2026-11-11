import type { Ref, RefSource } from '../refs/ref.js';
import { refKey } from '../refs/ref.js';
import { sidebarRefs, workLinks } from '../refs/summary.js';
import { LINK_PROVIDER_NAMES, type LinkInfo } from '../refs/work-link.js';
import type { SessionRefView } from '../rpc.js';
import { refLabel } from './links.js';

// How the agent reads a session's tracked work: the list that ends every link_work and
// unlink_work result, and the notice of links the agent did not make itself.

/** `PR acme/widgets#12` or `issue acme/widgets#7`. */
export function describe(ref: Ref): string {
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
  /** How it got linked; `branch` for a pull request of a branch the session pushed. */
  source: RefSource | 'branch';
  /** When it was linked; undefined for a branch pull request, which is never stored. */
  linkedAt: number | undefined;
  /** The label, then its state and origin in parentheses, then its title when known. */
  line: string;
}

/**
 * Where a tracked item came from. The agent reads it to tell its own links from detection's and
 * the user's, and to spot one that does not belong.
 */
const ORIGIN: Record<Exclude<RefSource, 'mention' | 'closes'>, string> = {
  agent: 'you linked it',
  created: 'you created it',
  manual: 'the user linked it',
  prompt: "from the user's message"
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
    const stored = link?.source === 'mention' ? undefined : link;
    const origin =
      stored === undefined || stored.source === 'mention'
        ? 'from the pushed branch'
        : stored.source === 'closes'
          ? closedBy(view, stored.via)
          : ORIGIN[stored.source];
    const details = [state?.status, origin].filter(Boolean).join(', ');
    return {
      key,
      label: describe(ref),
      source: stored?.source ?? 'branch',
      linkedAt: stored?.linkedAt,
      line: `${describe(ref)} (${details})${state ? `: ${state.title}` : ''}`
    };
  });
  const work = workLinks(view).map(
    (link): LinkedItem => ({
      key: link.key,
      label: describeLink(link),
      source: link.source,
      linkedAt: link.linkedAt,
      line: `${describeLink(link)} (${ORIGIN[link.source]})${link.title ? `: ${link.title}` : ''}`
    })
  );
  return [...refs, ...work];
}

/** `PR acme/widgets#12 closes it`, naming the tracked pull request a `closes` link came through. */
function closedBy(view: SessionRefView, via: string | undefined): string {
  const pr = [...view.branchRefs, ...view.links.map((link) => link.ref)].find(
    (ref) => refKey(ref) === via
  );
  return `${pr === undefined ? 'a linked pull request' : describe(pr)} closes it`;
}

/** The list that ends every link_work and unlink_work result. */
export function linkedList(view: SessionRefView | undefined): string {
  const items = view === undefined ? [] : linkedItems(view);
  return items.length === 0
    ? 'Nothing is linked to this session.'
    : ['Everything linked to this session:', ...items.map((item) => `- ${item.line}`)].join('\n');
}
