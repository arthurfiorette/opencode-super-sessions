import { usePlugin } from '@opencode/plugin/gui';
import { createSignal, For, type JSX, onCleanup, Show } from 'solid-js';
import {
  type LookIcon,
  openBadges,
  parseColors,
  refGlyph,
  refUrl,
  type StateColors,
  stateColor,
  type Tone
} from '../refs/look.js';
import { type Ref, type RefState, type RefStatus, refKey, refNumber } from '../refs/ref.js';
import type { ShownLink } from '../refs/summary.js';
import { LINK_PROVIDER_NAMES } from '../refs/work-link.js';
import { useOpenUrl, webUrl } from './links.js';
import { Octicon, type OcticonName } from './octicons.js';

// One ref or work link as every GUI surface draws it: the browser's rows, the session header, the
// Work list and the composer pill. The decisions (glyph, badges, their order and tones) come from
// `src/refs/look.ts`, the same ones the TUI draws with Nerd Font glyphs.

/** The octicon for each glyph the shared look names. */
const OCTICONS: Record<LookIcon, OcticonName> = {
  prOpen: 'git-pull-request',
  prDraft: 'git-pull-request-draft',
  prMerged: 'git-merge',
  prClosed: 'git-pull-request-closed',
  issueOpen: 'issue-opened',
  issueCompleted: 'issue-closed',
  issueNotPlanned: 'skip',
  changesRequested: 'file-diff',
  approved: 'check-circle-fill',
  reviewRequired: 'eye',
  checksPassing: 'check',
  checksFailing: 'x',
  checksPending: 'dot-fill',
  checksCancelled: 'stop',
  checksSkipped: 'skip',
  actionRequired: 'alert',
  conflicts: 'alert',
  threads: 'comment',
  stack: 'stack'
};

/** The octicon of a shared glyph. */
export function octiconOf(icon: LookIcon): OcticonName {
  return OCTICONS[icon];
}

/**
 * The CSS class of a tone, colored with the app's state variables in `styles.css`, so it follows
 * the user's theme.
 */
export function toneClass(tone: Tone): string {
  return `ss-tone-${tone}`;
}

/**
 * The color of a ref state in the app's light or dark mode: the `colors` option's override, else
 * GitHub's. Undefined for an unknown state, which reads muted so it never passes for open.
 */
function refColor(
  colors: StateColors,
  status: RefStatus | undefined,
  mode: 'light' | 'dark'
): string | undefined {
  return status === undefined ? undefined : stateColor(colors, status, mode);
}

/** How long the pointer rests on a row's detail line before the line becomes a link. */
export const LINK_DWELL = 400;

/** Props of {@link ExternalLink}. */
export interface ExternalLinkProps {
  readonly url: string;
  readonly class: string;
  readonly title?: string | undefined;
  /**
   * A line inside a row that a click opens: the line is the row's until the pointer rests on it
   * for {@link LINK_DWELL}, and a middle click or a click with cmd or ctrl opens it at once.
   */
  readonly dwell?: boolean | undefined;
  readonly children: JSX.Element;
}

/**
 * A link that opens its page where the app's link setting says, for the session of the surface
 * it renders in (`useOpenUrl`). An opening click stops here, so a row it sits in does not take
 * it, and the window never navigates away from the app.
 *
 * With `dwell` it has no page, underline or pointer cursor until it is armed, so a row's onControl
 * check passes the click to the row. Armed, it shows its title in the app's tooltip markup at
 * once: the native `title` tooltip comes on the system's own delay after a pointer move.
 */
export function ExternalLink(props: ExternalLinkProps) {
  const open = useOpenUrl();
  const [armed, setArmed] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => {
    clearTimeout(timer);
    setArmed(false);
  };
  onCleanup(() => clearTimeout(timer));
  const live = () => props.dwell !== true || armed();
  const href = () => (live() && webUrl(props.url) ? props.url : undefined);
  /** Opens the page now, whatever the line's state. */
  const go = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (webUrl(props.url)) open(props.url, event);
  };
  return (
    <a
      class={props.class}
      href={href()}
      title={props.dwell === true ? undefined : props.title}
      data-dwell={props.dwell === true ? (armed() ? 'armed' : 'inert') : undefined}
      onPointerEnter={() => {
        if (props.dwell !== true) return;
        clearTimeout(timer);
        timer = setTimeout(() => setArmed(true), LINK_DWELL);
      }}
      onPointerLeave={disarm}
      onClick={(event) => {
        if (live() || event.metaKey || event.ctrlKey) return go(event);
        // Inert: no page to follow, and the click goes on to the row.
        event.preventDefault();
      }}
      on:auxclick={(event) => {
        if (event.button === 1) go(event);
      }}
    >
      {props.children}
      <Show when={props.dwell === true && armed() ? props.title : undefined}>
        {(title) => (
          <span data-component="tooltip-v2" class="ss-ref-tip" role="tooltip">
            {title()}
          </span>
        )}
      </Show>
    </a>
  );
}

/** Props of {@link RefLine}. */
export interface RefLineProps {
  /** The ref to draw. Not `ref`, which Solid reserves for element refs. */
  readonly item: Ref;
  /** The ref's snapshot; undefined until the forge answered. */
  readonly state: RefState | undefined;
  /** Draws the title after the number. Defaults to true. */
  readonly titled?: boolean;
  /** Draws the review and CI badges of an open pull request. Defaults to true. */
  readonly badged?: boolean;
  /** Draws `passed/total` among the badges. Defaults to true; the session header has no room. */
  readonly counts?: boolean;
  /** Draws a stacked pull request's place in its stack. Defaults to true. */
  readonly stacked?: boolean;
  /** Wraps a long title onto more lines under itself instead of cutting it. Defaults to false. */
  readonly wrap?: boolean;
  /** A line inside a row: a link only once the pointer rested on it (`ExternalLink`). */
  readonly dwell?: boolean;
}

/** The class of a ref or work link line, which wraps its title when `wrap` is set. */
function lineClass(base: string, wrap: boolean | undefined): string {
  return wrap === true ? `${base} ss-ref-wrap` : base;
}

/**
 * One ref: its state glyph and number in GitHub's state color, the stack and place of a stacked
 * pull request, the review and CI badges of an open one, then its title. Opens the ref's page on
 * click.
 */
export function RefLine(props: RefLineProps) {
  const ctx = usePlugin();
  const status = () => props.state?.status;
  const colors = parseColors(ctx.options.colors);
  const color = () => refColor(colors, status(), ctx.appearance.mode());
  return (
    <ExternalLink
      class={lineClass('ss-ref', props.wrap)}
      url={refUrl(props.item, props.state)}
      title={props.state?.title}
      dwell={props.dwell}
    >
      <span
        class={`ss-ref-mark ss-state-${status() ?? 'unknown'}`}
        style={color() === undefined ? undefined : { color: color() }}
        data-ref={refKey(props.item)}
      >
        <Octicon name={OCTICONS[refGlyph(props.item.kind, status())]} class="ss-ref-icon" />
        <span class="ss-ref-number">{refNumber(props.item)}</span>
      </span>
      <RefBadges
        state={props.state}
        stacked={props.stacked ?? true}
        badged={props.badged ?? true}
        counts={props.counts ?? true}
      />
      <Show when={(props.titled ?? true) && props.state?.title}>
        {(title) => <span class="ss-ref-title">{title()}</span>}
      </Show>
    </ExternalLink>
  );
}

/** Props of {@link RefBadges}. */
export interface RefBadgesProps {
  readonly state: RefState | undefined;
  /** Draws a stacked pull request's place in its stack. */
  readonly stacked: boolean;
  /** Draws the review and CI badges of an open pull request. */
  readonly badged: boolean;
  /** Draws `passed/total` among the badges. */
  readonly counts: boolean;
}

/**
 * A pull request's stack place, then the review and CI badges of an open one, in the shared
 * order (`openBadges`). Nothing for an issue or a pull request without either.
 */
export function RefBadges(props: RefBadgesProps) {
  const ctx = usePlugin();
  return (
    <>
      <Show when={props.stacked && props.state?.stack}>
        {(stack) => (
          <span class="ss-ref-stack" title={ctx.t('ref.stack')}>
            <Octicon name="stack" size={12} />
            {`${stack().position}/${stack().size}`}
          </span>
        )}
      </Show>
      <Show when={props.badged}>
        <For each={openBadges(props.state, props.counts)}>
          {(badge) => (
            <span
              class={`ss-badge ss-badge-${badge.kind} ${toneClass(badge.tone)}`}
              title={ctx.t(`badge.${badge.icon ?? badge.kind}`)}
            >
              <Show when={badge.icon}>
                {(icon) => <Octicon name={OCTICONS[icon()]} size={12} />}
              </Show>
              <Show when={badge.text}>{(text) => <span>{text()}</span>}</Show>
            </span>
          )}
        </For>
      </Show>
    </>
  );
}

/** Props of {@link WorkLinkLine}. */
export interface WorkLinkLineProps {
  readonly link: ShownLink;
  /** Draws the title after the id. Defaults to true; a link without an id always shows it. */
  readonly titled?: boolean;
  /** Wraps a long title onto more lines under itself instead of cutting it. Defaults to false. */
  readonly wrap?: boolean;
  /** A line inside a row: a link only once the pointer rested on it (`ExternalLink`). */
  readonly dwell?: boolean;
}

/**
 * One work link: the link glyph and the tracker's id, such as `COR-1466`, in the info color, then
 * its title. Nothing reports a work link's state, so it never takes a state color.
 */
export function WorkLinkLine(props: WorkLinkLineProps) {
  // A link without an id, such as a Notion page, shows its title in the id's place.
  const titled = () => (props.titled ?? true) || props.link.name === undefined;
  return (
    <ExternalLink
      class={lineClass('ss-ref ss-work-link', props.wrap)}
      url={props.link.url}
      title={LINK_PROVIDER_NAMES[props.link.provider]}
      dwell={props.dwell}
    >
      <span class="ss-ref-mark ss-tone-info">
        <Octicon name="link" class="ss-ref-icon" />
        <Show when={props.link.name}>{(name) => <span class="ss-ref-number">{name()}</span>}</Show>
      </span>
      <Show when={titled() && props.link.title}>
        {(title) => <span class="ss-ref-title">{title()}</span>}
      </Show>
    </ExternalLink>
  );
}
