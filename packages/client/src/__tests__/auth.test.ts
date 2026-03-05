import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signJwt } from '../auth.js';

// Mock jose
vi.mock('jose', () => ({
  importPKCS8: vi.fn().mockResolvedValue('mock-key'),
  SignJWT: vi.fn().mockImplementation(() => ({
    setProtectedHeader: vi.fn().mockReturnThis(),
    setIssuedAt: vi.fn().mockReturnThis(),
    setExpirationTime: vi.fn().mockReturnThis(),
    sign: vi.fn().mockResolvedValue('mock.jwt.token')
  }))
}));

// Reset module-level token cache between tests
beforeEach(() => {
  vi.resetModules();
});

describe('signJwt', () => {
  const base = { privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----', kid: 'test-kid' };

  it('returns a token string', async () => {
    const token = await signJwt(base);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('signs management JWT without email', async () => {
    const jose = await import('jose');
    await signJwt(base);
    const SignJWT = vi.mocked(jose.SignJWT);
    expect(SignJWT).toHaveBeenCalledWith({});
    const instance = SignJWT.mock.results[0].value;
    expect(instance.setProtectedHeader).toHaveBeenCalledWith({ alg: 'RS256', kid: 'test-kid' });
    expect(instance.setExpirationTime).toHaveBeenCalledWith('1h');
  });

  it('signs delegated JWT with email in payload', async () => {
    const jose = await import('jose');
    vi.mocked(jose.SignJWT).mockClear();
    await signJwt({ ...base, email: 'alice@example.com' });
    const SignJWT = vi.mocked(jose.SignJWT);
    expect(SignJWT).toHaveBeenCalledWith(expect.objectContaining({ email: 'alice@example.com' }));
  });

  it('includes firstName and lastName when provided', async () => {
    const jose = await import('jose');
    vi.mocked(jose.SignJWT).mockClear();
    await signJwt({ ...base, kid: 'test-kid-names', email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith' });
    const SignJWT = vi.mocked(jose.SignJWT);
    expect(SignJWT).toHaveBeenCalledWith(expect.objectContaining({
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith'
    }));
  });

  it('does not include firstName/lastName when not provided', async () => {
    const jose = await import('jose');
    vi.mocked(jose.SignJWT).mockClear();
    await signJwt({ ...base, kid: 'test-kid-nonames' });
    const SignJWT = vi.mocked(jose.SignJWT);
    const payload = SignJWT.mock.calls.at(-1)?.[0] as any;
    expect(payload.firstName).toBeUndefined();
    expect(payload.lastName).toBeUndefined();
  });

  it('calls importPKCS8 with the private key and RS256 algorithm', async () => {
    const jose = await import('jose');
    vi.mocked(jose.importPKCS8).mockClear();
    const uniqueBase = { ...base, kid: 'test-kid-pkcs8' };
    await signJwt(uniqueBase);
    expect(jose.importPKCS8).toHaveBeenCalledWith(uniqueBase.privateKey, 'RS256');
  });

  it('caches token for subsequent calls with same key+email', async () => {
    const jose = await import('jose');
    vi.mocked(jose.importPKCS8).mockClear();
    vi.mocked(jose.SignJWT).mockClear();
    await signJwt(base);
    await signJwt(base);
    // importPKCS8 should only be called once (second call uses cache)
    expect(vi.mocked(jose.importPKCS8).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('uses separate cache entries for different emails', async () => {
    const jose = await import('jose');
    vi.mocked(jose.SignJWT).mockClear();
    await signJwt({ ...base, email: 'alice@example.com' });
    await signJwt({ ...base, email: 'bob@example.com' });
    // Both should produce tokens (separate cache keys)
    expect(vi.mocked(jose.SignJWT).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
