import type { Json, JsonSchema, JsonObject } from '../contracts/index.js';

/**
 * Minimal JSON-Schema-subset validator (type/object/array/string/number/integer/
 * boolean/enum/required/properties/items/minLength/maxLength/min/max).
 * Enough to validate model-emitted arguments; MCP providers see the original
 * schema anyway. Returns list of human-readable errors (empty = valid).
 */
export function validateArgs(schema: JsonSchema | undefined, value: unknown): string[] {
  const errors: string[] = [];
  checkNode(schema as Record<string, unknown> as JsonObject | undefined, value, '$', errors);
  return errors;
}

function checkNode(schema: JsonObject | undefined, value: unknown, path: string, errors: string[]): void {
  if (!schema || typeof schema !== 'object') return;
  const type = schema.type;

  if (typeof type === 'string' && !matchesType(type, value)) {
    errors.push(`${path}: expected ${type}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v: Json) => v === value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }
  if (type === 'object' && isObj(value)) {
    const props = (schema.properties ?? {}) as Record<string, JsonObject>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const r of required) {
      if (!(r in value)) errors.push(`${path}.${r}: required property missing`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) checkNode(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: additional property not allowed`);
    }
  }
  if (type === 'string' && typeof value === 'string') {
    const min = schema.minLength, max = schema.maxLength;
    if (typeof min === 'number' && value.length < min) errors.push(`${path}: shorter than minLength ${min}`);
    if (typeof max === 'number' && value.length > max) errors.push(`${path}: longer than maxLength ${max} (got ${value.length})`);
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match pattern ${schema.pattern}`);
      } catch {
        /* invalid pattern in provider schema — ignore */
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (type === 'array' && Array.isArray(value)) {
    const items = schema.items as JsonObject | undefined;
    value.forEach((v, i) => checkNode(items, v, `${path}[${i}]`, errors));
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isObj(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

const isObj = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
