import "server-only";

import { getRuntimeEnv } from "@/lib/runtime-env";

export type EncryptedPayload = {
  alg: "AES-GCM";
  iv: string;
  ciphertext: string;
  encoded: "base64";
};

export async function encryptJsonPayload(payload: Record<string, unknown>): Promise<EncryptedPayload> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("当前运行环境不支持凭据加密。");

  const encoder = new TextEncoder();
  const keyMaterial = await cryptoApi.subtle.digest("SHA-256", encoder.encode(getSecretEncryptionKey()));
  const key = await cryptoApi.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const encrypted = await cryptoApi.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload)));

  return {
    alg: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    encoded: "base64",
  };
}

export async function decryptJsonPayload(payload: unknown): Promise<Record<string, unknown> | null> {
  if (!payload || typeof payload !== "object") return null;
  const encryptedPayload = payload as Partial<EncryptedPayload>;
  if (
    encryptedPayload.alg !== "AES-GCM" ||
    encryptedPayload.encoded !== "base64" ||
    typeof encryptedPayload.iv !== "string" ||
    typeof encryptedPayload.ciphertext !== "string"
  ) {
    return null;
  }

  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("当前运行环境不支持凭据解密。");

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyMaterial = await cryptoApi.subtle.digest("SHA-256", encoder.encode(getSecretEncryptionKey()));
  const key = await cryptoApi.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["decrypt"]);
  const decrypted = await cryptoApi.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encryptedPayload.iv) },
    key,
    base64ToBytes(encryptedPayload.ciphertext),
  );

  const parsed = JSON.parse(decoder.decode(decrypted));
  return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
}

export function assertSecretEncryptionReady(): void {
  getSecretEncryptionKey();
}

function getSecretEncryptionKey(): string {
  const dedicatedSecret = getRuntimeEnv("API_TRANSIT_CREDENTIAL_ENCRYPTION_KEY");
  const adminSecret = getRuntimeEnv("ADMIN_SESSION_SECRET");
  const secret =
    dedicatedSecret ||
    (adminSecret ? `priceai:api-transit-credentials:v1:${adminSecret}` : "");
  if (!secret || secret.length < 32) {
    throw new Error(
      "服务端未配置 API_TRANSIT_CREDENTIAL_ENCRYPTION_KEY 或 ADMIN_SESSION_SECRET，暂时无法保存敏感配置。",
    );
  }
  return secret;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
