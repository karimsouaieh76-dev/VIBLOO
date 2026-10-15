import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";

const scryptAsync = promisify(scrypt);

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, keyHex] = String(stored).split(":");
  if (!saltHex || !keyHex) return false; // a deleted account has no password
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

export function makeTokens(secret) {
  return {
    sign: (user, version = 0) =>
      jwt.sign({ sub: String(user.id), username: user.username, v: version }, secret, { expiresIn: "30d" }),
    verify(token) {
      try {
        const p = jwt.verify(token, secret);
        return { id: Number(p.sub), username: p.username, v: Number(p.v) || 0 };
      } catch {
        return null;
      }
    },
  };
}
