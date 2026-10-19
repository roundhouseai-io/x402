/**
 * JSON as data, and the predicates that narrow it.
 *
 * Config files, 402 bodies, ledger lines and RPC replies all arrive as JSON
 * text. `JSON.parse` can only produce these shapes, so `JsonValue` is the
 * honest type at every one of those boundaries — narrower than `unknown`, and
 * still something each reader has to inspect before trusting a field.
 *
 * The predicates are generic (`<T>(value: T): value is T & X`) rather than
 * taking `unknown`, so they narrow whatever the caller holds without widening
 * it first; the `typeof` checks live here, inside named type guards, instead of
 * being repeated inline at every read.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue | undefined };

/** Parse JSON text. Throws `SyntaxError` on malformed input, like `JSON.parse`. */
export function parseJson(text: string): JsonValue {
  // `JSON.parse` is typed `any`; with no reviver its result is, by definition,
  // one of the JsonValue shapes.
  const value: JsonValue = JSON.parse(text);
  return value;
}

/**
 * A JSON object: not null, not an array. The first overload narrows a JSON
 * value to exactly `JsonObject`; the generic one narrows anything else.
 */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject;
export function isJsonObject<T>(value: T): value is T & JsonObject;
export function isJsonObject<T>(value: T): value is T & JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: JsonValue | undefined): value is string;
export function isString<T>(value: T): value is T & string;
export function isString<T>(value: T): value is T & string {
  return typeof value === 'string';
}

export function isNumber(value: JsonValue | undefined): value is number;
export function isNumber<T>(value: T): value is T & number;
export function isNumber<T>(value: T): value is T & number {
  return typeof value === 'number';
}

export function isBoolean(value: JsonValue | undefined): value is boolean;
export function isBoolean<T>(value: T): value is T & boolean;
export function isBoolean<T>(value: T): value is T & boolean {
  return typeof value === 'boolean';
}

export function isBigInt<T>(value: T): value is T & bigint {
  return typeof value === 'bigint';
}

/** A string field of a JSON object, or undefined when absent or not a string. */
export function stringField(obj: JsonObject, key: string): string | undefined {
  const value = obj[key];
  return isString(value) ? value : undefined;
}

/** A number field of a JSON object, or undefined when absent or not a number. */
export function numberField(obj: JsonObject, key: string): number | undefined {
  const value = obj[key];
  return isNumber(value) ? value : undefined;
}

/** An object field of a JSON object, or undefined when absent or not an object. */
export function objectField(obj: JsonObject, key: string): JsonObject | undefined {
  const value = obj[key];
  return isJsonObject(value) ? value : undefined;
}
