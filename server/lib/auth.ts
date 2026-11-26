import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { readStore, updateStore } from './storage.ts';

const EPHEMERAL_SECRET = crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const revokedTokens = new Set<string>();

function getSigningSecret(): string {
  const envSecret = process.env.SESSION_SECRET?.trim();
  return envSecret && envSecret.length >= 16 ? envSecret : EPHEMERAL_SECRET;
}

export function hashPassword(password: string, existingSalt?: string): { hash: string; salt: string } {
  const salt = existingSalt ?? crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash: derived, salt };
}

export function verifyPassword(password: string, expectedHash: string, salt: string): boolean {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function timingSafeTextEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function isEnvOwnerConfigured(): boolean {
  return Boolean(process.env.OWNER_PASSWORD && process.env.OWNER_PASSWORD.trim().length > 0);
}

export async function getAuthStatus(): Promise<{
  needsSetup: boolean;
  envManaged: boolean;
  ownerEmail: string | null;
}> {
  if (isEnvOwnerConfigured()) {
    return {
      needsSetup: false,
      envManaged: true,
      ownerEmail: process.env.OWNER_EMAIL?.trim() || 'owner@s7wari.app',
    };
  }
  const store = await readStore();
  return {
    needsSetup: store.owner === null,
    envManaged: false,
    ownerEmail: store.owner?.email ?? null,
  };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConflictError';
  }
}

export async function claimInitialOwner(email: string, password: string): Promise<{ token: string; email: string }> {
  if (isEnvOwnerConfigured()) {
    throw new Error('Owner credentials are managed by environment variables.');
  }
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || cleanEmail.length > 254 || !EMAIL_REGEX.test(cleanEmail)) {
    throw new Error('Please enter a valid email address.');
  }
  if (password.length < 8 || password.length > 256) {
    throw new Error('Password must be at least 8 characters long.');
  }

  await updateStore((draft) => {
    if (draft.owner !== null) {
      throw new Error('Owner account is already configured. Please sign in.');
    }
    const { hash, salt } = hashPassword(password);
    draft.owner = {
      email: cleanEmail,
      passwordHash: hash,
      salt,
      updatedAt: new Date().toISOString(),
    };
  });

  return { token: signSessionToken(cleanEmail), email: cleanEmail };
}

export async function registerUser(email: string, password: string): Promise<{ token: string; email: string }> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || cleanEmail.length > 254 || !EMAIL_REGEX.test(cleanEmail)) {
    throw new Error('Please enter a valid email address.');
  }
  if (password.length < 8 || password.length > 256) {
    throw new Error('Password must be at least 8 characters long.');
  }

  await updateStore((draft) => {
    const envEmail = isEnvOwnerConfigured() ? (process.env.OWNER_EMAIL?.trim().toLowerCase() || '') : '';
    const existingUsers = draft.users ?? [];
    const existsInEnv = Boolean(envEmail && timingSafeTextEqual(cleanEmail, envEmail));
    const existsAsOwner = Boolean(draft.owner && timingSafeTextEqual(cleanEmail, draft.owner.email.toLowerCase()));
    const existsInUsers = existingUsers.some((user) => timingSafeTextEqual(cleanEmail, user.email.toLowerCase()));

    if (existsInEnv || existsAsOwner || existsInUsers) {
      throw new AuthConflictError('An account with this email already exists. Please sign in.');
    }

    const { hash, salt } = hashPassword(password);
    draft.users = [
      ...existingUsers,
      {
        email: cleanEmail,
        passwordHash: hash,
        salt,
        updatedAt: new Date().toISOString(),
      },
    ];
  });

  return { token: signSessionToken(cleanEmail), email: cleanEmail };
}

export async function authenticateOwner(email: string, password: string): Promise<{ token: string; email: string } | null> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !password) return null;

  if (isEnvOwnerConfigured()) {
    const envPass = process.env.OWNER_PASSWORD!.trim();
    const envEmail = (process.env.OWNER_EMAIL?.trim() || '').toLowerCase();
    const emailOk = envEmail ? timingSafeTextEqual(cleanEmail, envEmail) : cleanEmail.length > 0;
    const passOk = timingSafeTextEqual(password, envPass);
    if (emailOk && passOk) {
      const resolvedEmail = envEmail || cleanEmail;
      return { token: signSessionToken(resolvedEmail), email: resolvedEmail };
    }
  }

  const store = await readStore();
  if (
    store.owner &&
    timingSafeTextEqual(cleanEmail, store.owner.email.toLowerCase()) &&
    verifyPassword(password, store.owner.passwordHash, store.owner.salt)
  ) {
    return { token: signSessionToken(store.owner.email), email: store.owner.email };
  }

  for (const user of store.users ?? []) {
    if (
      timingSafeTextEqual(cleanEmail, user.email.toLowerCase()) &&
      verifyPassword(password, user.passwordHash, user.salt)
    ) {
      return { token: signSessionToken(user.email), email: user.email };
    }
  }

  return null;
}

export async function updateOwnerCredentials(
  currentPassword: string,
  newEmail: string,
  newPassword?: string,
  actingEmail?: string
): Promise<{ email: string }> {
  const cleanNewEmail = newEmail.trim().toLowerCase();
  if (!cleanNewEmail || cleanNewEmail.length > 254 || !EMAIL_REGEX.test(cleanNewEmail)) {
    throw new Error('Please enter a valid email address.');
  }
  if (newPassword && (newPassword.length < 8 || newPassword.length > 256)) {
    throw new Error('New password must be at least 8 characters long.');
  }

  const envEmail = isEnvOwnerConfigured() ? (process.env.OWNER_EMAIL?.trim().toLowerCase() || '') : '';
  const cleanActing = actingEmail?.trim().toLowerCase() || '';
  if (isEnvOwnerConfigured() && (!cleanActing || !envEmail || timingSafeTextEqual(cleanActing, envEmail))) {
    throw new Error('Credentials are managed via environment secrets and cannot be changed in the UI.');
  }

  await updateStore((draft) => {
    const users = draft.users ?? [];
    const userIndex = cleanActing
      ? users.findIndex((u) => timingSafeTextEqual(cleanActing, u.email.toLowerCase()))
      : -1;

    if (userIndex >= 0) {
      const currentUser = users[userIndex];
      if (!verifyPassword(currentPassword, currentUser.passwordHash, currentUser.salt)) {
        throw new Error('Current password is incorrect.');
      }
      const conflictWithOwner = Boolean(
        draft.owner && timingSafeTextEqual(cleanNewEmail, draft.owner.email.toLowerCase())
      );
      const conflictWithOtherUser = users.some(
        (u, idx) => idx !== userIndex && timingSafeTextEqual(cleanNewEmail, u.email.toLowerCase())
      );
      const conflictWithEnv = Boolean(envEmail && timingSafeTextEqual(cleanNewEmail, envEmail));
      if (conflictWithOwner || conflictWithOtherUser || conflictWithEnv) {
        throw new Error('That email is already used by another account.');
      }
      const nextCreds = newPassword
        ? hashPassword(newPassword)
        : { hash: currentUser.passwordHash, salt: currentUser.salt };
      users[userIndex] = {
        email: cleanNewEmail,
        passwordHash: nextCreds.hash,
        salt: nextCreds.salt,
        updatedAt: new Date().toISOString(),
      };
      draft.users = users;
      return;
    }

    if (isEnvOwnerConfigured()) {
      throw new Error('Credentials are managed via environment secrets and cannot be changed in the UI.');
    }
    if (!draft.owner) {
      throw new Error('Owner account is not initialized.');
    }
    if (!verifyPassword(currentPassword, draft.owner.passwordHash, draft.owner.salt)) {
      throw new Error('Current password is incorrect.');
    }
    const conflictWithUsers = users.some((u) => timingSafeTextEqual(cleanNewEmail, u.email.toLowerCase()));
    if (conflictWithUsers) {
      throw new Error('That email is already used by another account.');
    }
    const nextCreds = newPassword
      ? hashPassword(newPassword)
      : { hash: draft.owner.passwordHash, salt: draft.owner.salt };
    draft.owner = {
      email: cleanNewEmail,
      passwordHash: nextCreds.hash,
      salt: nextCreds.salt,
      updatedAt: new Date().toISOString(),
    };
  });

  return { email: cleanNewEmail };
}

export function signSessionToken(email: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: email,
      iat: Date.now(),
      exp: Date.now() + TOKEN_TTL_MS,
      jti: crypto.randomBytes(12).toString('hex'),
    })
  ).toString('base64url');

  const sig = crypto.createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySessionToken(token: string): { email: string } | null {
  if (!token || revokedTokens.has(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;

  const expectedSig = crypto.createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: string;
      exp?: number;
    };
    if (!parsed.sub || !parsed.exp || Date.now() > parsed.exp) {
      return null;
    }
    return { email: parsed.sub };
  } catch {
    return null;
  }
}

export function revokeSessionToken(token: string): void {
  if (token) {
    revokedTokens.add(token);
  }
}

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }
  const session = verifySessionToken(token);
  if (!session) {
    res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
    return;
  }
  (req as Request & { userEmail?: string }).userEmail = session.email;
  next();
}
