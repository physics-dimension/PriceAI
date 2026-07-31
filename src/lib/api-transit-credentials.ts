import "server-only";

import { getRuntimeEnv } from "@/lib/runtime-env";
import { encryptJsonPayload, type EncryptedPayload } from "@/lib/secret-crypto";
import { getSupabaseServerClient } from "@/lib/supabase";
import { stableId } from "@/lib/utils";

export type TransitCredentialAccessMode = "test_key" | "test_account";

export type TransitCredentialInput = {
  accessMode: TransitCredentialAccessMode;
  submissionId: string;
  stationId?: string | null;
  submitterIp?: string | null;
  budgetLimit?: string | null;
  expiresAt?: string | null;
  allowedModels?: string[];
  allowedGroups?: string[];
  groupName?: string | null;
  groupId?: string | number | null;
  accountPool?: string | null;
  family?: string | null;
  standardModel?: string | null;
  rawModelName?: string | null;
  notes?: string | null;
  apiKey?: string | null;
  loginUrl?: string | null;
  username?: string | null;
  password?: string | null;
};

export async function assertTransitCredentialStorageReady() {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，暂时无法接收测试凭据。");
  getCredentialEncryptionSecret();

  const { error } = await supabase.from("api_transit_credentials").select("id").limit(1);
  if (error) throw new Error("测试凭据表尚未初始化，请先执行 Supabase 迁移。");
}

export async function createTransitCredential(input: TransitCredentialInput) {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw new Error("Supabase 尚未配置，暂时无法接收测试凭据。");

  const credentialType = input.accessMode === "test_account" ? "test_account" : "test_key";
  const secretPayload = buildSecretPayload(input);
  const encryptedPayload = await encryptCredentialPayload(secretPayload);
  const credentialMeta = buildCredentialMeta(input);

  const { error } = await supabase.from("api_transit_credentials").upsert(
    {
      id: stableId("api-transit-credential", input.submissionId, credentialType),
      submission_id: input.submissionId,
      station_id: input.stationId || null,
      credential_type: credentialType,
      status: "submitted",
      encrypted_payload: encryptedPayload,
      credential_meta: credentialMeta,
      expires_at: normalizeDate(input.expiresAt),
      submitter_ip: input.submitterIp || null,
    },
    { onConflict: "submission_id,credential_type" },
  );

  if (error) throw error;
}

function buildSecretPayload(input: TransitCredentialInput) {
  if (input.accessMode === "test_key") {
    return {
      type: "test_key",
      api_key: cleanRequired(input.apiKey, "请填写测试 API Key。"),
      budget_limit: cleanText(input.budgetLimit),
      expires_at: cleanText(input.expiresAt),
      allowed_models: cleanList(input.allowedModels),
      allowed_groups: cleanList(input.allowedGroups),
      group_name: cleanText(input.groupName),
      group_id: cleanText(input.groupId),
      account_pool: cleanText(input.accountPool),
      family: cleanText(input.family),
      standard_model: cleanText(input.standardModel),
      raw_model_name: cleanText(input.rawModelName),
      notes: cleanText(input.notes),
    };
  }

  return {
    type: "test_account",
    login_url: cleanRequired(input.loginUrl, "请填写测试账号登录地址。"),
    username: cleanRequired(input.username, "请填写测试账号。"),
    password: cleanRequired(input.password, "请填写测试账号密码。"),
    budget_limit: cleanText(input.budgetLimit),
    expires_at: cleanText(input.expiresAt),
    allowed_models: cleanList(input.allowedModels),
    allowed_groups: cleanList(input.allowedGroups),
    group_name: cleanText(input.groupName),
    group_id: cleanText(input.groupId),
    account_pool: cleanText(input.accountPool),
    family: cleanText(input.family),
    standard_model: cleanText(input.standardModel),
    raw_model_name: cleanText(input.rawModelName),
    notes: cleanText(input.notes),
  };
}

function buildCredentialMeta(input: TransitCredentialInput) {
  const loginHost = input.loginUrl ? safeHost(input.loginUrl) : null;
  return {
    access_mode: input.accessMode,
    budget_limit: cleanText(input.budgetLimit),
    expires_at: cleanText(input.expiresAt),
    allowed_models: cleanList(input.allowedModels),
    allowed_groups: cleanList(input.allowedGroups),
    group_name: cleanText(input.groupName),
    group_id: cleanText(input.groupId),
    account_pool: cleanText(input.accountPool),
    family: cleanText(input.family),
    standard_model: cleanText(input.standardModel),
    raw_model_name: cleanText(input.rawModelName),
    login_host: loginHost,
    has_api_key: input.accessMode === "test_key",
    has_test_account: input.accessMode === "test_account",
  };
}

async function encryptCredentialPayload(payload: Record<string, unknown>): Promise<EncryptedPayload> {
  const secret = getCredentialEncryptionSecret();
  if (!secret) throw new Error("服务端未配置 API_TRANSIT_CREDENTIAL_ENCRYPTION_KEY，暂时无法接收测试凭据。");
  return encryptJsonPayload(payload);
}

function getCredentialEncryptionSecret(): string {
  const dedicatedSecret = getRuntimeEnv("API_TRANSIT_CREDENTIAL_ENCRYPTION_KEY");
  const adminSecret = getRuntimeEnv("ADMIN_SESSION_SECRET");
  const secret =
    dedicatedSecret ||
    (adminSecret ? `priceai:api-transit-credentials:v1:${adminSecret}` : "");
  if (!secret || secret.length < 32) {
    throw new Error(
      "服务端未配置 API_TRANSIT_CREDENTIAL_ENCRYPTION_KEY 或 ADMIN_SESSION_SECRET，暂时无法接收测试凭据。",
    );
  }
  return secret;
}

function cleanRequired(value: string | null | undefined, message: string): string {
  const text = cleanText(value);
  if (!text) throw new Error(message);
  return text;
}

function cleanText(value: string | number | null | undefined): string | null {
  const text = String(value || "").trim();
  return text ? text : null;
}

function cleanList(values: string[] | null | undefined): string[] {
  return Array.from(new Set((values || []).map((value) => value.trim()).filter(Boolean))).slice(0, 30);
}

function normalizeDate(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeHost(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}
