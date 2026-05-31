/** 加解密端口（port）：纯接口，不引用 Electron，便于注入纯函数与在测试中替换为 fake。 */
export interface Encryptor {
  /** OS 钥匙串是否可用。不可用时拒绝存储密钥，绝不明文落库。 */
  isAvailable(): boolean;
  /** 明文 → 密文 buffer。 */
  encrypt(plaintext: string): Buffer;
  /** 密文 buffer → 明文。失败时抛出。 */
  decrypt(ciphertext: Buffer): string;
}
