// Every error response has the shape {"error": "<code>", "message": "<text>"}.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const invalidRequest = (message) => new ApiError(400, 'invalid_request', message);

export function routeNotFound(req, res, next) {
  next(new ApiError(404, 'not_found', 'Route not found'));
}

// Express recognises an error handler by its four arguments.
export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }

  // Client errors raised by Express itself: body too large, unreadable or
  // wrongly encoded body, malformed %-encoding in the URL, ...
  if (err.status >= 400 && err.status < 500) {
    return res.status(400).json({ error: 'invalid_request', message: 'Request could not be read' });
  }

  // Unexpected: log it (never the request headers, which hold the token).
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
}
