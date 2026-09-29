/**
 * Optional at-rest encryption for auth storage.
 *
 * If ENCRYPT_KEY is set in the environment (>=16 chars), auth.json contents
 * are transparently encrypted with AES-256-GCM. Plain JSON files are still
 * readable to support a one-way migration: first read decodes plain JSON,
 * next write produces ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, } from 'crypto';
const ALGO = 'aes-256-gcm';
const SALT = 'sap-auth-mcp';
const ITERATIONS = 100000;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
function deriveKey(secret) {
    return pbkdf2Sync(secret, SALT, ITERATIONS, KEY_LENGTH, 'sha256');
}
export function encryptString(plaintext, secret) {
    const key = deriveKey(secret);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
}
export function decryptBuffer(buf, secret) {
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const data = buf.subarray(IV_LENGTH + TAG_LENGTH);
    const key = deriveKey(secret);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
}
export function isPlainJson(buf) {
    const first = buf[0];
    return first === 0x7b || first === 0x5b;
}
export function getEncryptKey() {
    const key = process.env.ENCRYPT_KEY;
    if (key && key.length < 16) {
        throw new Error(`ENCRYPT_KEY must be at least 16 characters (got ${key.length})`);
    }
    return key;
}
//# sourceMappingURL=secure-store.js.map