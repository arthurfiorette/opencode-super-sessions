import type { Plugin } from '@opencode/plugin/tui';
import type { ResolvedTheme } from '@opencode/theme/tui';
import { type MouseEvent, type RGBA, TextAttributes } from '@opentui/core';
import { jsx } from '@opentui/solid/jsx-runtime';
import {
  createComponent,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  untrack
} from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { refUrl } from './browser.js';
import type { Options } from './config.js';
import { clickLink } from './link.js';
import { type createMarquee, marqueeText } from './marquee.js';
import { checkLook, hasListedChecks, listedChecks } from './page/checks.js';
import { linkColor, linkIcon, refColor, refIcon } from './page/icons.js';
import { badgeSegments, cells, fitText } from './page/row.js';
import {
  type PullCheck,
  type PullDetails,
  type Ref,
  type RefReview,
  type RefState,
  refKey,
  refNumber
} from './refs/ref.js';
import type { ShownLink } from './refs/summary.js';

// Cells taken by a ref glyph and its trailing space (see `ICONS`).
const ICON = 2;
// Blank cells between the title and the marker at the right end.
const MARKER_GAP = 2;

/** Inputs of {@link workRow}. */
export interface WorkRowInput {
  context: Plugin.Context;
  options: Options;
  theme(): ResolvedTheme;
  ref(): Ref;
  state(): RefState | undefined;
  /** Cells of the whole row. */
  width(): number;
  marquee: ReturnType<typeof createMarquee>;
  /** Keyboard selection, drawn in the action selection colors like a selected list row. */
  selected?(): boolean;
  /** Small muted note at the right end, such as `closes` for an issue a pull request closes. */
  marker?(): string | undefined;
  /** Element id; the parts get `-icon`, `-number` and `-title` after it. */
  id?: string;
}

// Failed checks listed under a pull request before the rest fold into `+N more`.
const FAILED_SHOWN = 5;

/** The review of an open or draft pull request, or undefined for any other ref. */
function openReview(state: RefState | undefined): RefReview | undefined {
  return state?.status === 'open' || state?.status === 'draft' ? state.review : undefined;
}

/**
 * Whether the lines under an open pull request (see {@link workStatus}) have something to show:
 * a review verdict, a CI result, merge conflicts or unresolved threads for the icon line, which
 * failing checks always come with.
 */
export function hasWorkStatus(state: RefState | undefined): boolean {
  const review = openReview(state);
  if (review === undefined) return false;
  return (
    review.decision !== undefined ||
    review.checks !== undefined ||
    review.conflicts === true ||
    (review.unresolved ?? 0) > 0
  );
}

/** The page of a pull request that lists all its checks: `/checks` on GitHub, pipelines on GitLab. */
export function checksPage(ref: Ref, state: RefState | undefined): string {
  return `${refUrl(ref, state)}/${ref.provider === 'gitlab' ? 'pipelines' : 'checks'}`;
}

/**
 * Details of the open pull requests among `refs()` that have checks to list by name (see
 * {@link hasListedChecks}), loaded through `load` (the server's details cache) whenever that set
 * or their check counts change, so a new CI result lists its failed checks. A key stays
 * undefined while loading or after a failed load.
 */
export function createFailedChecks(input: {
  refs(): Array<{ ref: Ref; state: RefState | undefined }>;
  load(ref: Ref): Promise<PullDetails>;
}): (key: string) => PullDetails | undefined {
  const [details, setDetails] = createStore<Record<string, PullDetails>>({});
  const wanted = createMemo(() =>
    input
      .refs()
      .filter((item) => item.ref.kind === 'pr' && hasListedChecks(openReview(item.state)))
      .map((item) => {
        const review = item.state?.review;
        const counts = [review?.checksPassed, review?.checksTotal, review?.checksFailed];
        return { ref: item.ref, stamp: `${refKey(item.ref)}@${counts.join('/')}` };
      })
  );
  createEffect(
    on(
      () =>
        wanted()
          .map((item) => item.stamp)
          .join(' '),
      () => {
        for (const { ref } of untrack(wanted)) {
          const key = refKey(ref);
          Promise.resolve()
            .then(() => input.load(ref))
            .then(
              (found) => setDetails(key, reconcile(found)),
              () => {}
            );
        }
      }
    )
  );
  return (key) => details[key];
}

/**
 * The lines under an open pull request in a Work section, indented by one icon slot: the review,
 * conflict and thread icons without words or check counts (see {@link badgeSegments}), then the
 * checks that failed or wait for an action (see {@link listedChecks}), at most five and then
 * `+N more`. The first check shares the icons' line and the rest line up under it, so the CI
 * icon shows only while no check is listed, since each check carries its own. Cancelled checks
 * are counted on the rows, never listed. The icons sit here rather than on the pull request's
 * line so a narrow sidebar keeps room for the title. A listed check links to its page and
 * `+N more` to the pull request's checks page; a click opens them and a ctrl+click copies them,
 * and hover makes them bold. The icons are not a link. Empty for any other ref.
 */
export function workStatus(input: {
  context: Plugin.Context;
  theme(): ResolvedTheme;
  ref(): Ref;
  state(): RefState | undefined;
  /** The pull request's details, which hold its checks; undefined while unknown. */
  details(): PullDetails | undefined;
  /** Cells of the whole row. */
  width(): number;
}): JSX.Element {
  const { context, theme } = input;
  const review = () => openReview(input.state());
  const room = () => Math.floor(input.width()) - ICON;
  const failed = () => (hasListedChecks(review()) ? listedChecks(input.details()?.checks) : []);
  // Each badge starts with its separating space, which the line's first one does not need. A gap
  // of two cells parts the icons from a first check on their line.
  const icons = () => {
    const listed = failed().length > 0;
    const badges = badgeSegments(review(), theme(), false, !listed).map((segment, index) =>
      index === 0 ? { ...segment, text: segment.text.trimStart() } : segment
    );
    return listed && badges.length > 0
      ? [...badges, { text: '  ', fg: theme().text.muted }]
      : badges;
  };
  // Cells before each check's icon, so every check lines up under the first one.
  const indent = () => icons().reduce((sum, segment) => sum + cells(segment.text), 0);

  /** Segments in their colors, cut together to `left` cells, the room by default. */
  const fitted = (
    segments: Array<{ text: string; fg: string | RGBA }>,
    bold = false,
    left = room()
  ) => {
    let rest = left;
    return segments.map((segment) => {
      const text = fitText(segment.text, rest);
      rest -= cells(text);
      return jsx('span', { style: { fg: segment.fg, bold }, children: text });
    });
  };
  /** A line that links to `url()`, bold while hovered. */
  const link = (
    url: () => string | undefined,
    segments: () => Array<{ text: string; fg: string | RGBA }>
  ) => {
    const [hovered, setHovered] = createSignal(false);
    return jsx('text', {
      flexShrink: 0,
      wrapMode: 'none',
      onMouseOver: () => setHovered(true),
      onMouseOut: () => setHovered(false),
      onMouseUp: (event: MouseEvent) => {
        clickLink(context, url(), event);
      },
      get children() {
        return fitted(segments(), hovered(), room() - indent());
      }
    });
  };

  // The icons and a column of checks side by side: the first check sits on the icons' line and
  // the column keeps the others under it.
  return jsx('box', {
    flexDirection: 'row',
    alignItems: 'flex-start',
    flexShrink: 0,
    paddingLeft: ICON,
    get visible() {
      return icons().length > 0 || failed().length > 0;
    },
    children: [
      jsx('text', {
        flexShrink: 0,
        wrapMode: 'none',
        get visible() {
          return icons().length > 0;
        },
        get children() {
          return fitted(icons());
        }
      }),
      jsx('box', {
        flexDirection: 'column',
        flexShrink: 0,
        children: [
          createComponent(For, {
            get each() {
              return failed().slice(0, FAILED_SHOWN);
            },
            children: (check: PullCheck) =>
              link(
                () => check.url,
                () => {
                  const [glyph, fg] = checkLook(check.status, theme());
                  return [
                    { text: `${glyph} `, fg },
                    { text: check.name, fg: theme().text.base }
                  ];
                }
              )
          }),
          jsx('box', {
            flexShrink: 0,
            get visible() {
              return failed().length > FAILED_SHOWN;
            },
            children: link(
              () => checksPage(input.ref(), input.state()),
              () => [{ text: `+${failed().length - FAILED_SHOWN} more`, fg: theme().text.muted }]
            )
          })
        ]
      })
    ]
  });
}

/**
 * One line of a Work section, shared by the session sidebar and the browser's preview: the state
 * icon, starting in the column of the section's triangle like the host's MCP dots, the number in
 * `text.base`, then the muted title. An open pull request's review and CI icons go on the line
 * under it (see {@link workStatus}). Hover brightens the number and the title and scrolls a cut
 * title; a click opens the ref's page and a ctrl+click copies its URL. Built once per position,
 * so updates change properties, never the tree.
 */
export function workRow(input: WorkRowInput): JSX.Element {
  return lineRow({
    ...input,
    key: () => refKey(input.ref()),
    icon: () => refIcon(input.ref().kind, input.state()?.status),
    iconFg: () =>
      refColor(input.options, input.state()?.status, input.theme(), input.context.themeMode),
    number: () => refNumber(input.ref()),
    title: () => input.state()?.title ?? '',
    url: () => refUrl(input.ref(), input.state())
  });
}

/** Inputs of {@link linkRow}. */
export interface LinkRowInput
  extends Pick<WorkRowInput, 'context' | 'theme' | 'width' | 'marquee' | 'selected' | 'id'> {
  link(): ShownLink;
}

/**
 * A work link's line in a Work section, laid out like {@link workRow}: the provider's glyph in
 * the info color, the id, then the muted title. A link without an id, such as a Notion page,
 * starts its title right after the glyph.
 */
export function linkRow(input: LinkRowInput): JSX.Element {
  return lineRow({
    ...input,
    key: () => input.link().key,
    icon: () => linkIcon(input.link().provider),
    iconFg: () => linkColor(input.theme()),
    number: () => input.link().name ?? '',
    title: () => input.link().title ?? '',
    url: () => input.link().url
  });
}

/** What {@link lineRow} draws: one ref or work link, and the page a click opens. */
interface LineInput
  extends Pick<
    WorkRowInput,
    'context' | 'theme' | 'width' | 'marquee' | 'selected' | 'marker' | 'id'
  > {
  key(): string;
  icon(): string;
  iconFg(): string | RGBA;
  /** The number or id; empty for a link that has none. */
  number(): string;
  title(): string;
  url(): string;
}

/** The line {@link workRow} and {@link linkRow} share. */
function lineRow(input: LineInput): JSX.Element {
  const context = input.context;
  const theme = input.theme;
  const [hovered, setHovered] = createSignal(false);
  const id = (part: string) => (input.id === undefined ? {} : { id: `${input.id}-${part}` });
  const key = input.key;
  const number = input.number;
  const title = input.title;
  const selected = () => input.selected?.() ?? false;
  /** Selection foreground over every part, or undefined for the parts' own colors. */
  const selectedFg = () => (selected() ? theme().text.action.primary.focused : undefined);
  const marker = () => input.marker?.();
  // The space between the number and the title; a line without a number needs none.
  const gap = () => (number() ? ' ' : '');
  /** Cells left for the title after the icon, the number, the marker and the spaces between. */
  const room = () => {
    const note = marker();
    return (
      Math.floor(input.width()) -
      ICON -
      cells(number()) -
      gap().length -
      (note ? cells(note) + MARKER_GAP : 0)
    );
  };
  return jsx('box', {
    ...(input.id === undefined ? {} : { id: input.id }),
    flexDirection: 'row',
    height: 1,
    flexShrink: 0,
    get backgroundColor() {
      return selected() ? theme().background.action.primary.focused : undefined;
    },
    onMouseOver: () => {
      setHovered(true);
      input.marquee.enter(key(), title(), room());
    },
    onMouseOut: () => {
      setHovered(false);
      input.marquee.leave(key());
    },
    onMouseUp: (event: MouseEvent) => {
      clickLink(context, input.url(), event);
    },
    children: [
      jsx('text', {
        ...id('icon'),
        flexShrink: 0,
        wrapMode: 'none',
        get fg() {
          return selectedFg() ?? input.iconFg();
        },
        get children() {
          return `${input.icon()} `;
        }
      }),
      jsx('text', {
        ...id('number'),
        flexShrink: 0,
        wrapMode: 'none',
        get fg() {
          return selectedFg() ?? theme().text.base;
        },
        // The number is already `text.base`, so hover brightens it with weight, like host toasts.
        // A selected list row is bold too.
        get attributes() {
          return hovered() || selected() ? TextAttributes.BOLD : TextAttributes.NONE;
        },
        get children() {
          return number();
        }
      }),
      jsx('text', {
        ...id('title'),
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        wrapMode: 'none',
        get fg() {
          return selectedFg() ?? (hovered() ? theme().text.base : theme().text.muted);
        },
        get children() {
          if (!title() || room() <= 0) return '';
          return input.marquee.active() === key() && input.marquee.offset() > 0
            ? `${gap()}${marqueeText(title(), room(), input.marquee.offset())}`
            : `${gap()}${fitText(title(), room())}`;
        }
      }),
      jsx('text', {
        flexShrink: 0,
        wrapMode: 'none',
        get visible() {
          return marker() !== undefined;
        },
        get fg() {
          return selectedFg() ?? theme().text.muted;
        },
        get children() {
          return `${' '.repeat(MARKER_GAP)}${marker() ?? ''}`;
        }
      })
    ]
  });
}
