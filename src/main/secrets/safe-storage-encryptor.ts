import { safeStorage } from "electron";
import type { Encryptor } from "@main/secrets/encryptor";

/** 基于 Electron safeStorage（OS 钥匙串）的真实加解密实现。仅在 main 胶水层使用，不进单测。 */
export const safeStorageEncryptor: Encryptor = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plaintext) => safeStorage.encryptString(plaintext),
  decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
};
