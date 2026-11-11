// Password helper — the one file every auth route touches when it reads or
// writes a password. These tests pin the policy (what counts as a legal
// password), the hash/verify round-trip, and the normalisation that keeps
// rate-limit bucketing honest.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validatePassword,
  hashPassword,
  verifyPassword,
  normaliseEmail,
  PASSWORD_MIN_LENGTH,
  PASSWORD_ATTEMPT_LIMIT,
  PASSWORD_ATTEMPT_WINDOW_MS,
} from "./password.ts";

// -------------------------------------------------------------------------
// validatePassword — the policy the UI and the API share.
// -------------------------------------------------------------------------

test("validatePassword accepts a reasonable password", () => {
  const r = validatePassword("correct horse battery staple");
  assert.equal(r.ok, true);
});

test("validatePassword rejects anything shorter than the minimum", () => {
  const r = validatePassword("short");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, new RegExp(`${PASSWORD_MIN_LENGTH} characters`));
});

test("validatePassword rejects a non-string", () => {
  const r = validatePassword(undefined);
  assert.equal(r.ok, false);
});

test("validatePassword refuses a password that equals the email", () => {
  // Case and whitespace don't let someone sneak by. The rule is about the
  // obvious footgun (a professional typing their own email as the password
  // during setup) — nothing more aggressive than that.
  const r = validatePassword("  Hello@Example.com  ", "hello@example.com");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /isn't your email/);
});

test("validatePassword rejects an absurdly long input (bcrypt truncates at 72 bytes)", () => {
  // Without this guard a professional could pick a 500-character password,
  // feel safe, and in fact only the first 72 bytes would protect them.
  const r = validatePassword("a".repeat(201));
  assert.equal(r.ok, false);
});

// -------------------------------------------------------------------------
// hash / verify round-trip.
// -------------------------------------------------------------------------

test("hashPassword + verifyPassword round-trip on a valid password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
});

test("hashPassword produces distinct hashes for the same password (salted)", async () => {
  const a = await hashPassword("correct horse battery staple");
  const b = await hashPassword("correct horse battery staple");
  assert.notEqual(a, b, "bcrypt must salt — two hashes of the same password should differ");
  // Both still verify.
  assert.equal(await verifyPassword("correct horse battery staple", a), true);
  assert.equal(await verifyPassword("correct horse battery staple", b), true);
});

test("verifyPassword returns false for a null or empty hash — the no-password-set case", async () => {
  // The password-login route reads user.password_hash and hands it in; a
  // user who never set a password has NULL there. verify must say false,
  // not throw, so the route's "same message for every failure" promise
  // holds without any extra null check at the callsite.
  assert.equal(await verifyPassword("anything", null), false);
  assert.equal(await verifyPassword("anything", undefined), false);
  assert.equal(await verifyPassword("anything", ""), false);
});

test("verifyPassword returns false for a malformed stored hash, without throwing", async () => {
  assert.equal(await verifyPassword("anything", "not-a-real-bcrypt-hash"), false);
});

// -------------------------------------------------------------------------
// Email normalisation — must match the magic-link path so an account
// bucketed by "Foo@Bar.com" there cannot rate-limit separately from
// "foo@bar.com" here.
// -------------------------------------------------------------------------

test("normaliseEmail lowercases and trims", () => {
  assert.equal(normaliseEmail("  Foo@Bar.COM  "), "foo@bar.com");
});

test("normaliseEmail tolerates null/undefined without throwing", () => {
  // The API route passes whatever JSON comes in; this shouldn't need a
  // defensive if-check at every callsite.
  assert.equal(normaliseEmail(undefined as unknown as string), "");
  assert.equal(normaliseEmail(null as unknown as string), "");
});

// -------------------------------------------------------------------------
// Rate-limit constants — not logic, but regressions here would silently
// weaken the gate. Pin the shape so a future refactor can't drift them.
// -------------------------------------------------------------------------

test("rate-limit window is 15 minutes with 5 attempts", () => {
  assert.equal(PASSWORD_ATTEMPT_LIMIT, 5);
  assert.equal(PASSWORD_ATTEMPT_WINDOW_MS, 15 * 60 * 1000);
});
