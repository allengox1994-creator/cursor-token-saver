// License 签发与校验：Ed25519 离线签名，无需联网激活、无电话回家。
// key 格式: CTS1.<base64url(payload JSON)>.<base64url(signature)>
// payload: { email, plan: 'pro'|'team', seats?, iat, exp }（时间为 epoch ms，exp=0 表示永久）
// 签发端用 vendor-private.pem（绝不入仓库/发布包），校验端只需下面内置的公钥。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { globalHome } from '../hooks/_lib.mjs';

const KEY_PREFIX = 'CTS1';
export const VENDOR_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA8a4MHBsolyuHHavlgZHuxCzoUM6bm3NEI2bhs4hnacs=
-----END PUBLIC KEY-----
`;

const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (s) => Buffer.from(s, 'base64url')
};

export function generateVendorKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  };
}

export function issueLicense({ email, plan = 'pro', seats = 1, days = 365 }, privateKeyPem) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail.includes('@')) return { error: 'valid email is required' };
  if (!['pro', 'team'].includes(plan)) return { error: `unknown plan: ${plan}` };
  const payload = {
    email: cleanEmail,
    plan,
    seats: Math.max(1, Number(seats) || 1),
    iat: Date.now(),
    exp: Number(days) > 0 ? Date.now() + Number(days) * 24 * 60 * 60 * 1000 : 0
  };
  const body = b64u.enc(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(privateKeyPem));
  return { key: `${KEY_PREFIX}.${body}.${b64u.enc(sig)}`, payload };
}

export function verifyLicense(key, publicKeyPem = VENDOR_PUBLIC_KEY) {
  try {
    const parts = String(key || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return { valid: false, reason: 'malformed key' };
    const ok = crypto.verify(null, Buffer.from(parts[1]), crypto.createPublicKey(publicKeyPem), b64u.dec(parts[2]));
    if (!ok) return { valid: false, reason: 'signature mismatch' };
    const payload = JSON.parse(b64u.dec(parts[1]).toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) {
      return { valid: false, reason: `expired at ${new Date(payload.exp).toISOString()}`, payload };
    }
    return { valid: true, payload };
  } catch (e) {
    return { valid: false, reason: `verification failed: ${e.message}` };
  }
}

function licensePath() {
  return path.join(globalHome(), 'license.json');
}

export function activateLicense(key, publicKeyPem = VENDOR_PUBLIC_KEY) {
  const res = verifyLicense(key, publicKeyPem);
  if (!res.valid) return res;
  fs.mkdirSync(globalHome(), { recursive: true });
  fs.writeFileSync(licensePath(), JSON.stringify({ key: String(key).trim(), activatedAt: new Date().toISOString() }, null, 2));
  return res;
}

export function deactivateLicense() {
  try {
    fs.unlinkSync(licensePath());
  } catch {}
}

// 当前生效的授权：无 license 或校验失败 → free（功能不锁死，商业策略是免费版完整可用）
export function licenseStatus(publicKeyPem = VENDOR_PUBLIC_KEY) {
  try {
    const stored = JSON.parse(fs.readFileSync(licensePath(), 'utf8'));
    const res = verifyLicense(stored.key, publicKeyPem);
    if (!res.valid) return { plan: 'free', reason: res.reason };
    return {
      plan: res.payload.plan,
      email: res.payload.email,
      seats: res.payload.seats,
      expiresAt: res.payload.exp ? new Date(res.payload.exp).toISOString() : 'never',
      activatedAt: stored.activatedAt
    };
  } catch {
    return { plan: 'free' };
  }
}
