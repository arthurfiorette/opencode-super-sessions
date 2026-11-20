import type {
  ComposerPillRow,
  ComposerPillTone,
  ComposerPillView,
  Context
} from '@opencode/plugin/gui';
import { checkMark, type LookIcon, refUrl, type Tone } from '../../refs/look.js';
import {
  type PullCheck,
  type PullDetails,
  type Ref,
  type RefReview,
  type RefState,
  refKey,
  refNumber
} from '../../refs/ref.js';
import { rowRefs } from '../../refs/summary.js';
import { checksPage } from '../../refs/work.js';
import type { SessionRefView } from '../../rpc.js';
import { webUrl } from '../ref-view.js';

// The composer pill: the session's main open pull request and its checks, above the composer.

/** An icon of the app's catalog; the SDK names the type but does not export it. */
type IconName = NonNullable<ComposerPillRow['icon']>;

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

/**
 * The pill's tone from a pull request's review and CI: failing checks, requested changes or
 * merge conflicts are danger; running checks or a pending review are a warning; passing checks
 * or an approval with nothing else in the way are success. Undefined while nothing is known, and
 * for runs that were only cancelled, which say nothing about the change.
 */
export function pillTone(review: RefReview | undefined): ComposerPillTone | undefined {
  if (review === undefined) return undefined;
  const { checks, decision } = review;
  if (checks === 'failing' || decision === 'changes_requested' || review.conflicts === true) {
    return 'danger';
  }
  if (checks === 'pending' || decision === 'review_required') return 'warning';
  if (checks === 'cancelled' || (checks === undefined && decision === undefined)) return undefined;
  return 'success';
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
  ctx: Pick<Context, 't' | 'system'>,
  view: SessionRefView | undefined,
  details: (key: string) => PullDetails | undefined
): ComposerPillView | undefined {
  const pull = mainPull(view);
  if (pull === undefined) return undefined;
  const { ref, state } = pull;
  const open = (url: string) => () => {
    if (webUrl(url)) ctx.system.openExternal(url);
  };
  const tone = pillTone(state.review);
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
    icon: ref.provider === 'github' ? 'github' : 'branch',
    ...(tone === undefined ? {} : { tone }),
    title: state.title,
    rows
  };
}
