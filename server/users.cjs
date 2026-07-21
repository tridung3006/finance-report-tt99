const crypto = require("crypto");

const PASSWORD_ITERATIONS = 600_000;

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function hashPassword(password, options = {}) {
  const iterations = Number(options.iterations || PASSWORD_ITERATIONS);
  const salt = options.salt || crypto.randomBytes(16).toString("base64url");
  const digest = crypto.pbkdf2Sync(String(password), salt, iterations, 32, "sha256").toString("base64url");
  return `pbkdf2$sha256$${iterations}$${salt}$${digest}`;
}

function timingSafeEqualText(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ""));
  const right = Buffer.from(String(rightValue || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyPassword(password, encodedHash) {
  const [scheme, digest, iterationsText, salt, expected] = String(encodedHash || "").split("$");
  const iterations = Number(iterationsText);
  if (scheme !== "pbkdf2" || digest !== "sha256" || !Number.isSafeInteger(iterations) || iterations < 1 || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(String(password || ""), salt, iterations, 32, "sha256").toString("base64url");
  return timingSafeEqualText(actual, expected);
}

module.exports = {
  PASSWORD_ITERATIONS,
  hashPassword,
  normalizeUsername,
  verifyPassword,
};
