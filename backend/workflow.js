export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const actions = {
  review: ['staff', ['submitted'], 'under_review'],
  forward: ['staff', ['under_review'], 'awaiting_approval'],
  correct: ['staff', ['under_review'], 'needs_correction'],
  'reject-ineligible': ['staff', ['under_review'], 'rejected'],
  resubmit: ['resident', ['needs_correction'], 'under_review'],
  'resubmit-assisted': ['staff', ['needs_correction'], 'under_review'],
  approve: ['approver', ['awaiting_approval'], 'approved'],
  reject: ['approver', ['awaiting_approval'], 'rejected'],
  ready: ['staff', ['approved'], 'ready'],
  release: ['staff', ['ready'], 'released'],
};

export function transition(action, status, role) {
  const rule = Object.hasOwn(actions, action) && actions[action];
  if (!rule) throw new HttpError(404, 'Unknown action.');
  const [requiredRole, from, to] = rule;
  if (requiredRole !== role) throw new HttpError(403, 'This action requires a different role.');
  if (!from.includes(status)) throw new HttpError(409, 'This request is no longer in the required status.');
  return to;
}
