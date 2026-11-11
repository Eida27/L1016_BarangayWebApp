import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transition } from '../backend/workflow.js';

test('staff and captain may decide requests after eligibility review', () => {
  for (const role of ['staff', 'approver']) {
    assert.equal(transition('approve', 'awaiting_approval', role), 'approved');
    assert.equal(transition('reject', 'awaiting_approval', role), 'rejected');
    assert.throws(() => transition('approve', 'under_review', role), { status: 409 });
  }
  assert.throws(() => transition('approve', 'awaiting_approval', 'admin'), { status: 403 });
});
