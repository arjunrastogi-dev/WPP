/**
 * Wrap an async Express handler so a rejected promise becomes a 500 response
 * instead of an unhandled rejection that takes the process down.
 *
 * Lives in its own module rather than in routes/index.js: the route files
 * import it, and importing it back from index.js would form a cycle that
 * leaves `route` in the temporal dead zone at module-evaluation time.
 */
export const route = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error('[api]', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
};
