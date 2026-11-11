import test from 'node:test';
import assert from 'node:assert/strict';
import { transition } from '../backend/workflow.js';

test('only approvers can approve a verified request', () => {
  assert.equal(transition('approve', 'awaiting_approval', 'approver'), 'approved');
  assert.throws(() => transition('approve', 'awaiting_approval', 'admin'), { status: 403 });
  assert.throws(() => transition('approve', 'submitted', 'approver'), { status: 409 });
});

test('corrections re-enter review and a release cannot repeat', () => {
  assert.equal(transition('resubmit', 'needs_correction', 'resident'), 'under_review');
  assert.equal(transition('release', 'ready', 'staff'), 'released');
  assert.throws(() => transition('release', 'released', 'staff'), { status: 409 });
});
