import { invalidRequest } from './errors.js';

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const MAX_AMOUNT = 1_000_000_000;

// A JSON number, kept exactly as written in the request ("100", "100.0", "1e2").
class JsonNumber {
  constructor(source) {
    this.source = source;
  }
}

// Parses the raw body text. Plain JSON.parse turns 100, 100.0 and 1e2 into the
// same value, so the reviver keeps each number's original text (Node 24+).
export function parseJsonObject(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw invalidRequest('Request body must be a JSON object');
  }

  let body;
  try {
    body = JSON.parse(text, (key, value, context) =>
      typeof value === 'number' ? new JsonNumber(context.source) : value,
    );
  } catch {
    throw invalidRequest('Malformed JSON');
  }

  if (body === null || Object.getPrototypeOf(body) !== Object.prototype) {
    throw invalidRequest('Request body must be a JSON object');
  }
  return body;
}

export function validateUserId(value) {
  if (value === undefined) throw invalidRequest('user_id is required');
  if (typeof value !== 'string' || !USER_ID.test(value)) {
    throw invalidRequest('user_id must be a string of 1 to 64 characters: A-Z, a-z, 0-9, _ or -');
  }
  return value;
}

export function validateAmount(value) {
  if (value === undefined) throw invalidRequest('amount is required');
  if (
    !(value instanceof JsonNumber) ||
    !POSITIVE_INTEGER.test(value.source) ||
    Number(value.source) > MAX_AMOUNT
  ) {
    throw invalidRequest('amount must be an integer from 1 to 1000000000');
  }
  return Number(value.source);
}

// Optional Idempotency-Key header: 1 to 255 visible ASCII characters.
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;

export function validateIdempotencyKey(value) {
  if (value === undefined) return undefined;
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw invalidRequest('Idempotency-Key must be 1 to 255 visible ASCII characters');
  }
  return value;
}

// Body of POST /credit and POST /debit. Unknown fields are ignored.
export function parseOperation(text) {
  const body = parseJsonObject(text);
  return {
    userId: validateUserId(body.user_id),
    amount: validateAmount(body.amount),
  };
}
