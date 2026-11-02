import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class TokenCrypto {
  private encryptionKey: Buffer;
  private signingKey: Buffer;

  constructor(secret: Buffer, private now: () => number = Date.now) {
    if (secret.length !== 32) throw new Error('Scheduler secret must contain exactly 32 bytes');
    this.encryptionKey = Buffer.from(hkdfSync('sha256', secret, 'calendar-scheduler:v1', 'refresh-tokens', 32));
    this.signingKey = Buffer.from(hkdfSync('sha256', secret, 'calendar-scheduler:v1', 'session-cookies', 32));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }

  decrypt(encrypted: string): string {
    const [version, iv, tag, data, extra] = encrypted.split('.');
    if (version !== 'v1' || !iv || !tag || data === undefined || extra !== undefined) throw new Error('Invalid encrypted token');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  signCookie(payload: Record<string, unknown>, ttlSeconds: number): string {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(this.now() / 1000) + ttlSeconds })).toString('base64url');
    return `${body}.${createHmac('sha256', this.signingKey).update(body).digest('base64url')}`;
  }

  verifyCookie<T>(signed: string): T | null {
    if (typeof signed !== 'string' || signed.length > 8192) return null;
    const [body, signature, extra] = signed.split('.');
    if (!body || !signature || extra !== undefined) return null;
    const expected = createHmac('sha256', this.signingKey).update(body).digest('base64url');
    if (!constantTimeEquals(signature, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload || !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(this.now() / 1000)) return null;
      return payload as T;
    } catch { return null; }
  }
}
