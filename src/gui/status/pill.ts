import type {
  ComposerPillRow,
  ComposerPillTone,
  ComposerPillView,
  Context,
  IconName,
  PluginIconName,
  SessionRef
} from '@opencode/plugin/gui';
import { openWebLink } from '../../host/gui.js';
import { checkMark, type LookIcon, pullTone, refUrl, type Tone } from '../../refs/look.js';
import {
  type PullCheck,
  type PullDetails,
  type Ref,
  type RefState,
  refKey,
  refNumber
} from '../../refs/ref.js';
import { rowRefs } from '../../refs/summary.js';
import { checksPage } from '../../refs/work.js';
import type { SessionRefView } from '../../rpc.js';
import { webUrl } from '../links.js';

// The composer pill: the session's main open pull request and its checks, above the composer.

/** The plugin's own icons the status views draw, by their names in `Plugin.define({ icons })`. */
export interface StatusIcons {
  readonly pull: PluginIconName;
  readonly pullDraft: PluginIconName;
}

/** Check rows the pill's menu lists before the rest fold into `+N more`. */
const CHECKS_SHOWN = 12;

/** The session's main pull request, the first a row shows, while it is open or a draft. */
export function mainPull(
  view: SessionRefView | undefined
): { ref: Ref; state: RefState } | undefined {
  if (view === undefined) return undefined;
  const ref = rowRefs(view).prs[0];
  const state = ref === undefined ? undefined : view.states[refKey(ref)];
  if (ref === undefined || state === undefined) return undefined;
  return state.status === 'open' || state.status === 'draft' ? { ref, state } : undefined;
}

/** Where a check lists in the menu: what needs the user first, passed and skipped ones last. */
const CHECK_ORDER: Record<PullCheck['status'], number> = {
  failure: 0,
  action_required: 1,
  pending: 2,
  cancelled: 3,
  success: 4,
  neutral: 4,
  skipped: 5
};

/** The app's icon for each check glyph the shared look names. */
const CHECK_ICONS: Partial<Record<LookIcon, IconName>> = {
  checksPassing: 'circle-check',
  checksFailing: 'circle-x',
  actionRequired: 'warning',
  checksPending: 'refresh',
  checksCancelled: 'circle-ban-sign',
  checksSkipped: 'dash'
};

/** The pill tone of a shared tone; muted has none. */
function pillToneOf(tone: Tone): ComposerPillTone | undefined {
  if (tone === 'error') return 'danger';
  return tone === 'muted' ? undefined : tone;
}

/**
 * What the pill shows for a session, or undefined when it has no open pull request. The menu
 * opens the pull request, then lists its checks from `details`, failed first in the forge's
 * order within each outcome, each opening its own page.
 */
export function pillView(
  ctx: Pick<Context, 't' | 'system' | 'links'>,
  icons: StatusIcons,
  session: SessionRef,
  view: SessionRefView | undefined,
  details: (key: string) => PullDetails | undefined
): ComposerPillView | undefined {
  const pull = mainPull(view);
  if (pull === undefined) return undefined;
  const { ref, state } = pull;
  // The menu's rows carry no click, so the app's link setting decides alone.
  const open = (url: string) => () => {
    if (webUrl(url)) openWebLink(ctx, url, session);
  };
  const shared = pullTone(state.review);
  const tone = shared === undefined ? undefined : pillToneOf(shared);
  const checks = [...(details(refKey(ref))?.checks ?? [])].sort(
    (a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]
  );
  const rows: ComposerPillRow[] = [
    {
      id: 'open',
      label: ctx.t('pill.open'),
      icon: 'square-arrow-top-right',
      detail: refNumber(ref),
      run: open(refUrl(ref, state))
    },
    ...checks.slice(0, CHECKS_SHOWN).map((check, index): ComposerPillRow => {
      const mark = checkMark(check.status);
      const icon = CHECK_ICONS[mark.icon];
      const checkTone = pillToneOf(mark.tone);
      return {
        id: `check-${index}`,
        label: check.name,
        ...(icon === undefined ? {} : { icon }),
        ...(checkTone === undefined ? {} : { tone: checkTone }),
        ...(check.url === undefined ? {} : { run: open(check.url) })
      };
    })
  ];
  if (checks.length > CHECKS_SHOWN) {
    rows.push({
      id: 'more',
      label: ctx.t('pill.more', { count: checks.length - CHECKS_SHOWN }),
      run: open(checksPage(ref, state))
    });
  }
  return {
    label: refNumber(ref),
    icon: state.status === 'draft' ? icons.pullDraft : icons.pull,
    ...(tone === undefined ? {} : { tone }),
    title: state.title,
    rows
  };
}
