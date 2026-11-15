import { describe, it, expect } from 'vitest';
import { newReviewId, assertReviewId } from '../src/store/ids.js';

describe('review ids', () => {
  it('generates ids matching the required pattern', () => {
    expect(newReviewId('doc')).toMatch(/^doc-\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(newReviewId('plan')).toMatch(/^plan-\d{8}-\d{6}-[a-z0-9]{4}$/);
  });
  it('rejects malformed or hostile ids', () => {
    for (const bad of ['', 'doc-1', '../etc', 'doc-20261109-142301-A3F9', 'doc-20261109-142301-a3f9; rm -rf /', 'x-20261109-142301-a3f9', null]) {
      expect(() => assertReviewId(bad)).toThrow();
    }
    expect(assertReviewId('doc-20261109-142301-a3f9')).toBe('doc-20261109-142301-a3f9');
  });
});
