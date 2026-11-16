// Lets each user run one write at a time, in arrival order.
//
// Why: writes for the same user must wait for that user's row lock in
// Postgres anyway. Without this queue, every waiting request would hold a
// pool connection while it waits, and one busy user could take the whole
// pool and stall everyone else. With it, a busy user holds at most one
// connection and other users always find a free one.
//
// This only rations connections; correctness comes from the database.

const queues = new Map(); // userId -> promise that settles when the user's last queued job finishes

export async function runForUser(userId, job) {
  const previous = queues.get(userId) ?? Promise.resolve();

  let finish;
  const current = new Promise((resolve) => (finish = resolve));
  const tail = previous.then(() => current);
  queues.set(userId, tail);

  await previous; // wait for this user's earlier jobs
  try {
    return await job();
  } finally {
    finish();
    // Nobody queued behind us: forget the user so the map doesn't grow forever.
    if (queues.get(userId) === tail) queues.delete(userId);
  }
}
