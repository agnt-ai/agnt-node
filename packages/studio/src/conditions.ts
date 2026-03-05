/**
 * Condition evaluation for v2 PromptManifest
 *
 * Evaluates LeafConditions and CompoundConditions against runtime variables.
 * Variable paths use dot notation: `variables.<key>` → variables['key']
 */

import type { Condition, LeafCondition, CompoundCondition } from './types.js';

function isCompound(c: Condition): c is CompoundCondition {
  return 'operator' in c;
}

/**
 * Resolve a variable path against the runtime context.
 * Supports: `variables.<key>` and bare key names as shorthand.
 */
function resolveVariablePath(path: string, variables: Record<string, any>): any {
  if (path.startsWith('variables.')) {
    return variables[path.slice('variables.'.length)];
  }
  // Bare key (shorthand)
  return variables[path];
}

/**
 * Evaluate a single leaf condition
 */
function evaluateLeaf(condition: LeafCondition, variables: Record<string, any>): boolean {
  const actual = resolveVariablePath(condition.variable, variables);
  const expected = condition.value;

  switch (condition.op) {
    case 'eq':        return actual === expected;
    case 'neq':       return actual !== expected;
    case 'gt':        return actual > expected;
    case 'gte':       return actual >= expected;
    case 'lt':        return actual < expected;
    case 'lte':       return actual <= expected;
    case 'in':        return Array.isArray(expected) && expected.includes(actual);
    case 'not_in':    return Array.isArray(expected) && !expected.includes(actual);
    case 'exists':    return actual !== undefined && actual !== null;
    case 'not_exists':return actual === undefined || actual === null;
    default:          return false;
  }
}

/**
 * Evaluate a condition (leaf or compound) against runtime variables.
 * Returns true if the condition passes (item should be included).
 * A null/undefined condition always passes.
 */
export function evaluateCondition(
  condition: Condition | null | undefined,
  variables: Record<string, any>
): boolean {
  if (!condition) return true;

  if (isCompound(condition)) {
    switch (condition.operator) {
      case 'AND': return condition.rules.every(r => evaluateCondition(r, variables));
      case 'OR':  return condition.rules.some(r => evaluateCondition(r, variables));
      case 'NOT': return condition.rules.length > 0 && !evaluateCondition(condition.rules[0], variables);
      default:    return false;
    }
  }

  return evaluateLeaf(condition as LeafCondition, variables);
}
