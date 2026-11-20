import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pullTone } from '../../src/refs/look.js';
import type { RefReview } from '../../src/refs/ref.js';

// The Desktop composer pill's one tone for a pull request: the worst signal wins, and a
// cancelled-only run or no data says nothing.
test('a pull request tone follows its worst review or CI signal', () => {
  const cases: Array<[RefReview | undefined, ReturnType<typeof pullTone>]> = [
    [undefined, undefined],
    [{}, undefined],
    [{ checks: 'cancelled' }, undefined],
    [{ checks: 'passing' }, 'success'],
    [{ decision: 'approved', checks: 'passing' }, 'success'],
    [{ decision: 'approved' }, 'success'],
    [{ checks: 'pending' }, 'warning'],
    [{ decision: 'review_required', checks: 'passing' }, 'warning'],
    [{ decision: 'approved', checks: 'pending' }, 'warning'],
    [{ checks: 'failing' }, 'error'],
    [{ decision: 'changes_requested', checks: 'passing' }, 'error'],
    [{ decision: 'approved', checks: 'passing', conflicts: true }, 'error'],
    [{ decision: 'review_required', checks: 'failing' }, 'error']
  ];
  for (const [review, tone] of cases) {
    assert.equal(pullTone(review), tone, JSON.stringify(review));
  }
});
