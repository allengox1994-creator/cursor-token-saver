// License 模块：签发/校验/篡改/过期/激活状态
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateVendorKeypair,
  issueLicense,
  verifyLicense,
  activateLicense,
  deactivateLicense,
  licenseStatus
} from '../src/license/license.mjs';

let home;
let keys;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-saver-license-'));
  process.env.CURSOR_TOKEN_SAVER_HOME = home;
  keys = generateVendorKeypair();
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test('签发 + 校验：合法 key 通过并还原 payload', () => {
  const res = issueLicense({ email: 'Dev@Example.com', plan: 'team', seats: 5, days: 30 }, keys.privateKeyPem);
  assert.ok(res.key.startsWith('CTS1.'));
  const v = verifyLicense(res.key, keys.publicKeyPem);
  assert.equal(v.valid, true);
  assert.equal(v.payload.email, 'dev@example.com', '邮箱应归一化为小写');
  assert.equal(v.payload.plan, 'team');
  assert.equal(v.payload.seats, 5);
  assert.ok(v.payload.exp > Date.now());
});

test('签发校验参数：坏邮箱/未知套餐被拒', () => {
  assert.ok(issueLicense({ email: 'nope', plan: 'pro' }, keys.privateKeyPem).error);
  assert.ok(issueLicense({ email: 'a@b.com', plan: 'ultimate' }, keys.privateKeyPem).error);
});

test('篡改与伪造：改 payload、换签名、格式错误都不通过', () => {
  const { key } = issueLicense({ email: 'a@b.com', plan: 'pro' }, keys.privateKeyPem);
  const [p, body, sig] = key.split('.');
  const forgedBody = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), plan: 'team' })
  ).toString('base64url');
  assert.equal(verifyLicense(`${p}.${forgedBody}.${sig}`, keys.publicKeyPem).valid, false, '改 payload 应失败');

  const other = generateVendorKeypair();
  const forged = issueLicense({ email: 'a@b.com', plan: 'pro' }, other.privateKeyPem);
  assert.equal(verifyLicense(forged.key, keys.publicKeyPem).valid, false, '别人私钥签的 key 应失败');

  assert.equal(verifyLicense('CTS1.garbage', keys.publicKeyPem).valid, false);
  assert.equal(verifyLicense('', keys.publicKeyPem).valid, false);
  assert.equal(verifyLicense('WRONG.' + body + '.' + sig, keys.publicKeyPem).valid, false);
});

test('过期：exp 过去的 key 校验失败并给出原因；days<=0 为永久', () => {
  // 直接签一个 exp 在过去的 payload，确定性验证过期分支
  const payload = { email: 'a@b.com', plan: 'pro', seats: 1, iat: Date.now() - 1000, exp: Date.now() - 500 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(keys.privateKeyPem)).toString('base64url');
  const v = verifyLicense(`CTS1.${body}.${sig}`, keys.publicKeyPem);
  assert.equal(v.valid, false);
  assert.match(v.reason, /expired at/);

  const forever = issueLicense({ email: 'a@b.com', plan: 'pro', days: 0 }, keys.privateKeyPem);
  assert.equal(forever.payload.exp, 0);
  assert.equal(verifyLicense(forever.key, keys.publicKeyPem).valid, true);
});

test('激活/状态/移除：落盘到全局目录，无授权时回落 free', () => {
  assert.equal(licenseStatus(keys.publicKeyPem).plan, 'free');

  const { key } = issueLicense({ email: 'buyer@corp.com', plan: 'pro', days: 365 }, keys.privateKeyPem);
  const act = activateLicense(key, keys.publicKeyPem);
  assert.equal(act.valid, true);
  assert.ok(fs.existsSync(path.join(home, 'license.json')));

  const st = licenseStatus(keys.publicKeyPem);
  assert.equal(st.plan, 'pro');
  assert.equal(st.email, 'buyer@corp.com');
  assert.notEqual(st.expiresAt, 'never');

  assert.equal(activateLicense('CTS1.bad.key', keys.publicKeyPem).valid, false, '坏 key 不应覆盖激活');

  deactivateLicense();
  assert.equal(licenseStatus(keys.publicKeyPem).plan, 'free');
});
