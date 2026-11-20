import { statusEn } from './status/en.js';

// The GUI's English copy, the source and the fallback of every key `ctx.t` reads.
export const en = {
  ...statusEn,
  'command.browse': 'Super Sessions: Browse sessions',
  'browser.title': 'Super Sessions',
  'refs.empty': 'This session tracks no pull requests, issues or links.',
  'refs.none': 'Open a session to see what it tracks.',
  'refs.unavailable': 'The opencode-super-sessions server plugin is not installed on this server.',
  'ref.stack': 'Place in its stack',
  'badge.changesRequested': 'Changes requested',
  'badge.approved': 'Approved',
  'badge.reviewRequired': 'Review required',
  'badge.checksPassing': 'Checks passing',
  'badge.checksFailing': 'Checks failing',
  'badge.checksPending': 'Checks pending',
  'badge.checksCancelled': 'Checks cancelled',
  'badge.counts': 'Checks passed',
  'badge.conflicts': 'Merge conflicts',
  'badge.threads': 'Unresolved review threads'
} as const;
