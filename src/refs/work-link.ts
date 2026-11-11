/**
 * Work links: pages on trackers other than the forges, such as a Linear issue or an Azure Boards
 * work item, or any other web page. They are read from the URL alone, with no network call, so
 * they work without a CLI, a token or access to a private workspace.
 */

/** Where a work link points. `url` is any page no recognizer claims. */
export type LinkProvider =
  | 'linear'
  | 'jira'
  | 'azure-boards'
  | 'sentry'
  | 'notion'
  | 'slack'
  | 'trello'
  | 'clickup'
  | 'shortcut'
  | 'asana'
  | 'url';

/** A provider's name in labels and tool results. */
export const LINK_PROVIDER_NAMES: Record<LinkProvider, string> = {
  linear: 'Linear',
  jira: 'Jira',
  'azure-boards': 'Azure Boards',
  sentry: 'Sentry',
  notion: 'Notion',
  slack: 'Slack',
  trello: 'Trello',
  clickup: 'ClickUp',
  shortcut: 'Shortcut',
  asana: 'Asana',
  url: 'link'
};

/** What a URL says about the work it points at. */
export interface LinkInfo {
  provider: LinkProvider;
  /**
   * Stable identity for dedupe and dismissal, prefixed `link:` so it never equals a forge ref's
   * key. Recognized links key on what they name, so two URLs of one Linear issue are one link.
   */
  key: string;
  /** The URL without its fragment or a trailing slash. */
  url: string;
  /** Short id drawn where a ref's number goes, such as `COR-1466`. A generic link uses its host. */
  name?: string;
  /** Title read from the URL, such as a Linear slug. A title the agent or user gave wins. */
  title?: string;
}

/** Longest URL a work link stores, matching `workLinkSchema`. */
export const URL_MAX = 2000;

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/u;
const DIGITS = /^\d+$/u;
const NOTION_ID = /([0-9a-f]{32})$/iu;
const NOTION_SUFFIX =
  /-?(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

/**
 * Reads a work link from a URL. Undefined for anything that is not an http(s) URL with a host;
 * every other URL is at least a generic `url` link.
 */
export function recognizeLink(text: string): LinkInfo | undefined {
  let parsed: URL;
  try {
    parsed = new URL(text.trim());
  } catch {
    return undefined;
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.hostname === '') {
    return undefined;
  }
  parsed.hash = '';
  // Credentials in a URL must not be stored or drawn.
  parsed.username = '';
  parsed.password = '';
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
  }
  const url = parsed.href;
  // Encoding can make a URL several times longer; a stored one must fit `workLinkSchema`.
  if (url.length > URL_MAX) return undefined;
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => safeDecode(segment));
  for (const recognize of RECOGNIZERS) {
    const found = recognize(host, segments, parsed.searchParams);
    if (found !== undefined) {
      const title = found.title === undefined ? undefined : cleanTitle(found.title);
      return {
        provider: found.provider,
        key: `link:${found.provider}:${found.id}`,
        url,
        ...(found.name === undefined ? {} : { name: found.name }),
        ...(title ? { title } : {})
      };
    }
  }
  const path = cleanTitle(`${safeDecode(parsed.pathname)}${safeDecode(parsed.search)}`);
  return {
    provider: 'url',
    key: plainKey(parsed),
    url,
    name: parsed.host.toLowerCase().replace(/^www\./u, ''),
    ...(path === '/' || path === '' ? {} : { title: path })
  };
}

/**
 * The key of a URL read as a plain link. The host and port are case-insensitive; paths and
 * queries may not be.
 */
function plainKey(parsed: URL): string {
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return `link:url:${parsed.host.toLowerCase()}${path}${parsed.search}`;
}

/**
 * A title fit for one terminal line: control characters, which a decoded slug or a title from
 * the agent may hold, become spaces, and runs of whitespace collapse.
 */
export function cleanTitle(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the target.
  return text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/gu, ' ').trim();
}

/**
 * A title without a leading copy of the link's id, as in `COR-1530: Plain agent events`, since
 * the id is always drawn right before it. A title that is only the id stays as it is.
 */
export function titleWithoutId(title: string, id: string | undefined): string {
  if (id === undefined || !title.toLowerCase().startsWith(id.toLowerCase())) return title;
  const rest = title.slice(id.length);
  // `COR-15300` is another id, not `COR-1530` followed by text.
  if (/^[\p{L}\p{N}_]/u.test(rest)) return title;
  return rest.replace(/^[\s:|-]+/u, '') || title;
}

/**
 * Every key a stored URL may have been dismissed under: its key now, and its plain-link key,
 * which it had before a recognizer for its site existed. A recognizer added later then never
 * brings back a link the user unlinked.
 */
export function dismissalKeys(info: LinkInfo): string[] {
  const plain = plainKey(new URL(info.url));
  return plain === info.key ? [info.key] : [info.key, plain];
}

/**
 * What one recognizer found. `id` is unique within the provider and keeps the case of the parts
 * that are case-sensitive, so it can be the key as is.
 */
interface Found {
  provider: Exclude<LinkProvider, 'url'>;
  id: string;
  name?: string;
  title?: string;
}

type Recognizer = (host: string, segments: string[], query: URLSearchParams) => Found | undefined;

const RECOGNIZERS: Recognizer[] = [
  // linear.app/<workspace>/issue/COR-1466/<slug>
  (host, [workspace, kind, id, slug]) => {
    if (host !== 'linear.app' || !workspace || kind !== 'issue' || !id || !ISSUE_KEY.test(id)) {
      return undefined;
    }
    const name = id.toUpperCase();
    return withTitle(
      { provider: 'linear', id: `${workspace.toLowerCase()}/${name}`, name },
      slugTitle(slug)
    );
  },
  // <site>.atlassian.net/browse/ABC-12, or a board with ?selectedIssue=ABC-12
  (host, segments, query) => {
    if (!host.endsWith('.atlassian.net')) return undefined;
    const browsed = segments[0] === 'browse' ? segments[1] : undefined;
    const id = browsed ?? query.get('selectedIssue') ?? undefined;
    if (!id || !ISSUE_KEY.test(id)) return undefined;
    const name = id.toUpperCase();
    return { provider: 'jira', id: `${host}/${name}`, name };
  },
  // dev.azure.com/<org>/<project>/_workitems/edit/140208, <org>.visualstudio.com/<project>/...,
  // or a board with ?workitem=140208. Work item ids are unique within an organization.
  (host, segments, query) => {
    const legacy = host.endsWith('.visualstudio.com');
    if (host !== 'dev.azure.com' && !legacy) return undefined;
    const org = legacy ? host.split('.')[0] : segments[0]?.toLowerCase();
    // `_workitems` right after the organization means the URL names no project, and
    // `DefaultCollection` is the collection of old `visualstudio.com` URLs.
    const project = (legacy ? segments : segments.slice(1)).find(
      (segment) => segment !== 'DefaultCollection'
    );
    const edit = segments.indexOf('_workitems');
    const id =
      edit !== -1 && segments[edit + 1] === 'edit' ? segments[edit + 2] : query.get('workitem');
    if (!org || !id || !DIGITS.test(id)) return undefined;
    // The project is all the URL says beyond the number; it reads better than a bare id.
    return withTitle(
      { provider: 'azure-boards', id: `${org}/${id}`, name: id },
      project?.startsWith('_') ? undefined : project
    );
  },
  // <org>.sentry.io/issues/123 or sentry.io/organizations/<org>/issues/123
  (host, segments) => {
    const hosted = host.endsWith('.sentry.io') && segments[0] === 'issues';
    const legacy =
      host === 'sentry.io' && segments[0] === 'organizations' && segments[2] === 'issues';
    const org = hosted ? host.split('.')[0] : legacy ? segments[1]?.toLowerCase() : undefined;
    const id = hosted ? segments[1] : legacy ? segments[3] : undefined;
    if (!org || !id || !DIGITS.test(id)) return undefined;
    return { provider: 'sentry', id: `${org}/${id}`, name: id };
  },
  // notion.so/<workspace>/Page-Title-<32 hex>, <workspace>.notion.site/..., or ?p=<32 hex>. The
  // id may also be written as a dashed UUID.
  (host, segments, query) => {
    if (host !== 'notion.so' && host !== 'www.notion.so' && !host.endsWith('.notion.site')) {
      return undefined;
    }
    const peeked = query.get('p');
    const last = peeked ?? segments.at(-1) ?? '';
    const id = NOTION_ID.exec(last.replace(/-/gu, ''))?.[1]?.toLowerCase();
    if (id === undefined) return undefined;
    const slug = peeked === null ? last.replace(NOTION_SUFFIX, '') : undefined;
    return withTitle({ provider: 'notion', id }, slugTitle(slug) ?? 'Notion page');
  },
  // <team>.slack.com/archives/<channel>/p1712345678901234. A reply's link names its thread in
  // `thread_ts`, so the whole thread is one link.
  (host, [archives, channel, message], query) => {
    if (!host.endsWith('.slack.com') || archives !== 'archives' || !channel) return undefined;
    if (!message || !/^p\d+$/u.test(message)) return undefined;
    const team = host.split('.')[0];
    const thread = query.get('thread_ts')?.replace('.', '');
    const id = thread && DIGITS.test(thread) ? `p${thread}` : message;
    return {
      provider: 'slack',
      id: `${team}/${channel.toUpperCase()}/${id}`,
      title: 'Slack thread'
    };
  },
  // trello.com/c/<short id>/12-card-title
  (host, [kind, id, slug]) => {
    if (host !== 'trello.com' || kind !== 'c' || !id) return undefined;
    return withTitle({ provider: 'trello', id }, slugTitle(slug?.replace(/^\d+-/u, '')));
  },
  // app.clickup.com/t/<task id> or app.clickup.com/t/<team>/<custom id>. Custom ids such as
  // `ENG-12` repeat across workspaces, so they keep their team.
  (host, [kind, first, second]) => {
    const id = second ?? first;
    if (host !== 'app.clickup.com' || kind !== 't' || !id) return undefined;
    return { provider: 'clickup', id: second === undefined ? id : `${first}/${id}`, name: id };
  },
  // app.shortcut.com/<org>/story/123/<slug>
  (host, [org, kind, id, slug]) => {
    if (host !== 'app.shortcut.com' || !org || kind !== 'story' || !id || !DIGITS.test(id)) {
      return undefined;
    }
    return withTitle(
      { provider: 'shortcut', id: `${org.toLowerCase()}/${id}`, name: `sc-${id}` },
      slugTitle(slug)
    );
  },
  // app.asana.com/0/<project>/<task>, or app.asana.com/1/<workspace>/project/<p>/task/<task>.
  // Home, inbox and portfolio pages also start with `/0/` and name no task.
  (host, segments) => {
    if (host !== 'app.asana.com') return undefined;
    const task = segments.indexOf('task');
    const legacy = segments[0] === '0' && DIGITS.test(segments[1] ?? '');
    const id = task !== -1 ? segments[task + 1] : legacy ? segments[2] : undefined;
    if (!id || !DIGITS.test(id)) return undefined;
    return { provider: 'asana', id, title: 'Asana task' };
  }
];

/** Adds `title` to a recognizer's answer when there is one. */
function withTitle(found: Found, title: string | undefined): Found {
  return title === undefined || title === '' ? found : { ...found, title };
}

/** A URL slug as words with the first one capitalized, as `fix-the-build` reads `Fix the build`. */
function slugTitle(slug: string | undefined): string | undefined {
  const words = slug?.replace(/[-_+]+/gu, ' ').trim();
  if (!words) return undefined;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Decodes a percent-encoded URL part, keeping it as is when it is malformed. */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// URLs in prose stop at whitespace, quotes and closing brackets, which a Markdown link or a
// parenthesized aside puts right after them.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]}]+/giu;

/**
 * Tracker URLs in a user prompt, deduped by key, in order. Generic pages are left out: prompts
 * paste documentation and search results far more often than the work itself.
 */
export function trackerLinks(text: string): LinkInfo[] {
  const found = new Map<string, LinkInfo>();
  for (const [match] of text.matchAll(URL_IN_TEXT)) {
    // Sentence punctuation after a URL is not part of it.
    const info = recognizeLink(match.replace(/[.,;:!?]+$/u, ''));
    if (info !== undefined && info.provider !== 'url' && !found.has(info.key)) {
      found.set(info.key, info);
    }
  }
  return [...found.values()];
}
