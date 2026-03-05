/**
 * JWT signing for Agnt API authentication.
 *
 * Management JWT: { iat, exp }           → account-level access
 * Delegated JWT:  { email, iat, exp }    → user-scoped access (auto-provisions user)
 *
 * Tokens are cached in-memory and refreshed when < 5 minutes from expiry.
 */

import * as jose from 'jose';

interface CachedToken {
  token: string;
  expiresAt: number; // ms
}

const tokenCache = new Map<string, CachedToken>();

export interface JwtSignOptions {
  privateKey: string;
  kid: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

export async function signJwt(options: JwtSignOptions): Promise<string> {
  const { privateKey: privateKeyPem, kid, email, firstName, lastName } = options;

  const cacheKey = `${kid}:${email ?? ''}`;
  const cached = tokenCache.get(cacheKey);

  // Reuse cached token if > 5 minutes of life remaining
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) {
    return cached.token;
  }

  const privateKey = await jose.importPKCS8(privateKeyPem, 'RS256');

  const payload: Record<string, string> = {};
  if (email) payload.email = email;
  if (firstName) payload.firstName = firstName;
  if (lastName) payload.lastName = lastName;

  const token = await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);

  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 60 * 60 * 1000 });
  return token;
}
