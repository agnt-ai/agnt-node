import { describe, it, expect } from 'vitest';
import { evaluateCondition } from '../conditions.js';

const vars = {
  status: 'open',
  count: 5,
  tags: ['billing', 'urgent'],
  name: 'Alice',
  empty: null
};

describe('evaluateCondition', () => {
  it('returns true for null/undefined condition', () => {
    expect(evaluateCondition(null, vars)).toBe(true);
    expect(evaluateCondition(undefined, vars)).toBe(true);
  });

  describe('leaf operators', () => {
    it('eq — equals', () => {
      expect(evaluateCondition({ variable: 'status', op: 'eq', value: 'open' }, vars)).toBe(true);
      expect(evaluateCondition({ variable: 'status', op: 'eq', value: 'closed' }, vars)).toBe(false);
    });

    it('neq — not equals', () => {
      expect(evaluateCondition({ variable: 'status', op: 'neq', value: 'closed' }, vars)).toBe(true);
      expect(evaluateCondition({ variable: 'status', op: 'neq', value: 'open' }, vars)).toBe(false);
    });

    it('gt — greater than', () => {
      expect(evaluateCondition({ variable: 'count', op: 'gt', value: 4 }, vars)).toBe(true);
      expect(evaluateCondition({ variable: 'count', op: 'gt', value: 5 }, vars)).toBe(false);
    });

    it('gte — greater than or equal', () => {
      expect(evaluateCondition({ variable: 'count', op: 'gte', value: 5 }, vars)).toBe(true);
      expect(evaluateCondition({ variable: 'count', op: 'gte', value: 6 }, vars)).toBe(false);
    });

    it('lt — less than', () => {
      expect(evaluateCondition({ variable: 'count', op: 'lt', value: 6 }, vars)).toBe(true);
      expect(evaluateCondition({ variable: 'count', op: 'lt', value: 5 }, vars)).toBe(false);
    });

    it('lte — less than or equal', () => {
      expect(evaluateCondition({ variable: 'count', op: 'lte', value: 5 }, vars)).toBe(true);
      expect(evaluateCondition({ variable: 'count', op: 'lte', value: 4 }, vars)).toBe(false);
    });

    it('in — value in array', () => {
      expect(evaluateCondition({ variable: 'status', op: 'in', value: ['open', 'pending'] }, vars)).toBe(true);
      expect(evaluateCondition({ variable: 'status', op: 'in', value: ['closed'] }, vars)).toBe(false);
    });

    it('not_in — value not in array', () => {
      expect(evaluateCondition({ variable: 'status', op: 'not_in', value: ['closed', 'done'] }, vars)).toBe(true);
      expect(evaluateCondition({ variable: 'status', op: 'not_in', value: ['open', 'pending'] }, vars)).toBe(false);
    });

    it('exists — value is not null/undefined', () => {
      expect(evaluateCondition({ variable: 'name', op: 'exists', value: null }, vars)).toBe(true);
      expect(evaluateCondition({ variable: 'empty', op: 'exists', value: null }, vars)).toBe(false);
      expect(evaluateCondition({ variable: 'missing', op: 'exists', value: null }, vars)).toBe(false);
    });

    it('not_exists — value is null/undefined', () => {
      expect(evaluateCondition({ variable: 'empty', op: 'not_exists', value: null }, vars)).toBe(true);
      expect(evaluateCondition({ variable: 'name', op: 'not_exists', value: null }, vars)).toBe(false);
    });

    it('unknown op returns false', () => {
      expect(evaluateCondition({ variable: 'status', op: 'unknown_op' as any, value: 'open' }, vars)).toBe(false);
    });
  });

  describe('variable path resolution', () => {
    it('resolves variables.<key> path', () => {
      expect(evaluateCondition({ variable: 'variables.status', op: 'eq', value: 'open' }, vars)).toBe(true);
    });

    it('resolves bare key as shorthand', () => {
      expect(evaluateCondition({ variable: 'count', op: 'eq', value: 5 }, vars)).toBe(true);
    });
  });

  describe('compound conditions', () => {
    it('AND — all rules must pass', () => {
      expect(evaluateCondition({
        operator: 'AND',
        rules: [
          { variable: 'status', op: 'eq', value: 'open' },
          { variable: 'count', op: 'gt', value: 3 }
        ]
      }, vars)).toBe(true);

      expect(evaluateCondition({
        operator: 'AND',
        rules: [
          { variable: 'status', op: 'eq', value: 'open' },
          { variable: 'count', op: 'gt', value: 10 }
        ]
      }, vars)).toBe(false);
    });

    it('OR — at least one rule must pass', () => {
      expect(evaluateCondition({
        operator: 'OR',
        rules: [
          { variable: 'status', op: 'eq', value: 'closed' },
          { variable: 'count', op: 'gt', value: 3 }
        ]
      }, vars)).toBe(true);

      expect(evaluateCondition({
        operator: 'OR',
        rules: [
          { variable: 'status', op: 'eq', value: 'closed' },
          { variable: 'count', op: 'gt', value: 10 }
        ]
      }, vars)).toBe(false);
    });

    it('NOT — negates the first rule', () => {
      expect(evaluateCondition({
        operator: 'NOT',
        rules: [{ variable: 'status', op: 'eq', value: 'closed' }]
      }, vars)).toBe(true);

      expect(evaluateCondition({
        operator: 'NOT',
        rules: [{ variable: 'status', op: 'eq', value: 'open' }]
      }, vars)).toBe(false);
    });

    it('NOT with empty rules returns false', () => {
      expect(evaluateCondition({ operator: 'NOT', rules: [] }, vars)).toBe(false);
    });

    it('nested compound conditions', () => {
      expect(evaluateCondition({
        operator: 'AND',
        rules: [
          { variable: 'status', op: 'eq', value: 'open' },
          {
            operator: 'OR',
            rules: [
              { variable: 'count', op: 'gt', value: 10 },
              { variable: 'name', op: 'eq', value: 'Alice' }
            ]
          }
        ]
      }, vars)).toBe(true);
    });

    it('unknown compound operator returns false', () => {
      expect(evaluateCondition({ operator: 'XOR' as any, rules: [] }, vars)).toBe(false);
    });
  });
});
