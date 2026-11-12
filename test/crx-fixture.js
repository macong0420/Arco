'use strict';
// 真实签名的 CRX fixture：测试不接受假签名包。
const crypto = require('node:crypto');
const CRX3_MAGIC = Buffer.from('CRX3 SignedData\0', 'binary');
function varint(value) {
  const bytes = [];
  let rest = value;
  while (rest > 0x7f) { bytes.push((rest & 0x7f) | 0x80); rest = Math.floor(rest / 128); }
  bytes.push(rest);
  return Buffer.from(bytes);
}
function field(number, payload) { return Buffer.concat([varint(number * 8 + 2), varint(payload.length), payload]); }
function keyID(publicKey) { return crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16); }
function extensionID(publicKey) { let id = ''; for (const byte of keyID(publicKey)) id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)); return id; }
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { publicKey: der, privateKey, id: extensionID(der) };
}
function crx3Header(zip, keys, { crxID = keyID(keys.publicKey), signedHeaderData, proof, extra = [] } = {}) {
  const data = signedHeaderData || field(1, crxID);
  const length = Buffer.alloc(4); length.writeUInt32LE(data.length);
  const signed = Buffer.concat([CRX3_MAGIC, length, data, zip]);
  const signature = crypto.sign('sha256', signed, keys.privateKey);
  const keyProof = proof || Buffer.concat([field(1, keys.publicKey), field(2, signature)]);
  return Buffer.concat([field(2, keyProof), field(10000, data), ...extra]);
}
function wrap(header, zip) {
  const head = Buffer.alloc(12); head.write('Cr24', 0, 'binary'); head.writeUInt32LE(3, 4); head.writeUInt32LE(header.length, 8);
  return Buffer.concat([head, header, zip]);
}
function signedCRX3(zip, keys, options = {}) { return wrap(crx3Header(zip, keys, options), zip); }
function signedCRX2(zip, keys) {
  const signature = crypto.sign('sha1', zip, keys.privateKey);
  const head = Buffer.alloc(16); head.write('Cr24', 0, 'binary'); head.writeUInt32LE(2, 4); head.writeUInt32LE(keys.publicKey.length, 8); head.writeUInt32LE(signature.length, 12);
  return Buffer.concat([head, keys.publicKey, signature, zip]);
}
module.exports = { CRX3_MAGIC, varint, field, keyID, extensionID, generateKeyPair, crx3Header, wrap, signedCRX3, signedCRX2 };
