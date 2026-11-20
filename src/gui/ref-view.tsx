import { usePlugin } from '@opencode/plugin/gui';
import { For, type JSX, Show } from 'solid-js';
import {
  GITHUB_COLORS,
  type LookIcon,
  openBadges,
  refGlyph,
  refUrl,
  type Tone
} from '../refs/look.js';
import { type Ref, type RefState, type RefStatus, refKey, refNumber } from '../refs/ref.js';
import type { ShownLink } from '../refs/summary.js';
import { LINK_PROVIDER_NAMES } from '../refs/work-link.js';
import { Octicon, type OcticonName } from './octicons.js';

// One ref or work link as every GUI surface draws it: the browser's rows, the session header, the
// Work panel and the composer pill. The decisions (glyph, badges, their order and tones) come from
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
 * GitHub's color for a ref state in the app's light or dark mode, or undefined for an unknown
 * state, which reads muted so it never passes for open.
 */
export function stateColor(
  status: RefStatus | undefined,
  mode: 'light' | 'dark'
): string | undefined {
  return status === undefined ? undefined : GITHUB_COLORS[status][mode];
}

/** Whether a URL is an http(s) page, the only kind the GUI hands to the system browser. */
function webUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Props of {@link ExternalLink}. */
interface ExternalLinkProps {
  readonly url: string;
  readonly class: string;
  readonly title?: string | undefined;
  readonly children: JSX.Element;
}

/**
 * A link that opens its page in the system browser. The click stops here, so a row it sits in
 * does not take it as a selection, and the window never navigates away from the app.
 */
function ExternalLink(props: ExternalLinkProps) {
  const ctx = usePlugin();
  const href = () => (webUrl(props.url) ? props.url : undefined);
  return (
    <a
      class={props.class}
      href={href()}
      title={props.title}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const url = href();
        if (url !== undefined) ctx.system.openExternal(url);
      }}
    >
      {props.children}
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
}

/**
 * One ref: its state glyph and number in GitHub's state color, the stack and place of a stacked
 * pull request, the review and CI badges of an open one, then its title. Opens the ref's page on
 * click.
 */
export function RefLine(props: RefLineProps) {
  const ctx = usePlugin();
  const status = () => props.state?.status;
  const color = () => stateColor(status(), ctx.appearance.mode());
  return (
    <ExternalLink class="ss-ref" url={refUrl(props.item, props.state)} title={props.state?.title}>
      <span
        class={`ss-ref-mark ss-state-${status() ?? 'unknown'}`}
        style={color() === undefined ? undefined : { color: color() }}
        data-ref={refKey(props.item)}
      >
        <Octicon name={OCTICONS[refGlyph(props.item.kind, status())]} class="ss-ref-icon" />
        <span class="ss-ref-number">{refNumber(props.item)}</span>
      </span>
      <Show when={props.state?.stack}>
        {(stack) => (
          <span class="ss-ref-stack" title={ctx.t('ref.stack')}>
            <Octicon name="stack" size={12} />
            {`${stack().position}/${stack().size}`}
          </span>
        )}
      </Show>
      <Show when={props.badged ?? true}>
        <For each={openBadges(props.state)}>
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
      <Show when={(props.titled ?? true) && props.state?.title}>
        {(title) => <span class="ss-ref-title">{title()}</span>}
      </Show>
    </ExternalLink>
  );
}

/** Props of {@link WorkLinkLine}. */
export interface WorkLinkLineProps {
  readonly link: ShownLink;
  /** Draws the title after the id. Defaults to true; a link without an id always shows it. */
  readonly titled?: boolean;
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
      class="ss-ref ss-work-link"
      url={props.link.url}
      title={LINK_PROVIDER_NAMES[props.link.provider]}
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
