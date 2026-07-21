const assert = require("node:assert/strict");
const { hashPassword, normalizeUsername, verifyPassword } = require("./users.cjs");

const hash = hashPassword("A-strong-test-password", { iterations: 1_000, salt: "test-salt" });
assert.equal(verifyPassword("A-strong-test-password", hash), true);
assert.equal(verifyPassword("wrong-password", hash), false);
assert.equal(verifyPassword("anything", "invalid"), false);
assert.equal(normalizeUsername("  Admin.User  "), "admin.user");
console.log("user authentication helper tests passed");
