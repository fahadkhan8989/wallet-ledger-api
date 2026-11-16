import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';

const sha256 = (text) => createHash('sha256').update(text).digest();

// Checks "Authorization: Bearer <token>" on every request it is mounted on.
// Runs before the body is read and before any database access.
export function requireToken(token) {
  const expected = sha256(token);

  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

    // Hashing both sides gives equal-length buffers, so timingSafeEqual's
    // running time depends neither on the token's content nor its length.
    if (provided === null || !timingSafeEqual(sha256(provided), expected)) {
      return next(new ApiError(401, 'unauthorized', 'Missing or invalid bearer token'));
    }
    next();
  };
}
