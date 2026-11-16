import express from 'express';
import { requireToken } from './auth.js';
import { ApiError, errorHandler, routeNotFound } from './errors.js';
import { parseOperation, validateIdempotencyKey, validateUserId } from './validate.js';

// Reads the body as plain text (any Content-Type); validate.js parses it.
const readBody = express.text({ type: () => true, limit: '1kb' });

// pg returns BIGINT as a string, so the balance is written into the JSON as-is
// and is never rounded by a JavaScript number.
function sendBalance(res, userId, balance) {
  res.type('application/json').send(`{"user_id":${JSON.stringify(userId)},"balance":${balance}}`);
}

const userNotFound = () => new ApiError(404, 'user_not_found', 'User has never been credited');

export function createApp({ token, ledger }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // Public on purpose (for load balancers / orchestrators); returns no data.
  app.get('/health', async (req, res) => {
    try {
      await ledger.ping();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ error: 'unavailable', message: 'Database is not reachable' });
    }
  });

  // Order matters: the token is checked first, before the body is read.
  app.use(requireToken(token));

  const operationRoute = (operation) => async (req, res) => {
    const { userId, amount } = parseOperation(req.body);
    const key = validateIdempotencyKey(req.get('idempotency-key'));
    const result = await ledger.apply(operation, userId, amount, key);

    if (result.status === 'ok') return sendBalance(res, userId, result.balance);
    if (result.status === 'user_not_found') throw userNotFound();
    if (result.status === 'insufficient_funds') {
      throw new ApiError(409, 'insufficient_funds', 'Balance is lower than the debit amount');
    }
    throw new ApiError(422, 'idempotency_key_reused', 'Idempotency-Key was already used for a different request');
  };

  app.post('/credit', readBody, operationRoute('credit'));
  app.post('/debit', readBody, operationRoute('debit'));

  // "{/:userId}" makes the id optional so that "/balance/" gives 400, not 404.
  app.get('/balance{/:userId}', async (req, res) => {
    const userId = validateUserId(req.params.userId ?? '');
    const balance = await ledger.getBalance(userId);
    if (balance === null) throw userNotFound();
    sendBalance(res, userId, balance);
  });

  app.use(routeNotFound);
  app.use(errorHandler);
  return app;
}
