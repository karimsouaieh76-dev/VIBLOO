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
  const [saltHex, keyHex] = stored.split(":");
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

export function makeTokens(secret) {
  return {
    sign: (user) => jwt.sign({ sub: String(user.id), username: user.username }, secret, { expiresIn: "30d" }),
    verify(token) {
      try {
        const p = jwt.verify(token, secret);
        return { id: Number(p.sub), username: p.username };
      } catch {
        return null;
      }
    },
  };
}
