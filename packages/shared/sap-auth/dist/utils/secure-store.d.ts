/**
 * Optional at-rest encryption for auth storage.
 *
 * If ENCRYPT_KEY is set in the environment (>=16 chars), auth.json contents
 * are transparently encrypted with AES-256-GCM. Plain JSON files are still
 * readable to support a one-way migration: first read decodes plain JSON,
 * next write produces ciphertext.
 */
export declare function encryptString(plaintext: string, secret: string): Buffer;
export declare function decryptBuffer(buf: Buffer, secret: string): string;
export declare function isPlainJson(buf: Buffer): boolean;
export declare function getEncryptKey(): string | undefined;
//# sourceMappingURL=secure-store.d.ts.map