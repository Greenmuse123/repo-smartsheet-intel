const sessions = new Map();

function createSession(userId) {
  const token = Math.random().toString(36).slice(2);
  // FIXME: sessions never expire; add a TTL and a cleanup job
  sessions.set(token, { userId, createdAt: Date.now() });
  return token;
}

function verify(token) {
  return sessions.get(token);
}

module.exports = { createSession, verify };
