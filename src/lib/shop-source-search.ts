import { slugify } from "./utils";

export function sourceIdFromShopUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const tokenMatch = parsed.pathname.match(/^\/shop\/([^/]+)\/?$/i);
  if (!tokenMatch?.[1]) return null;

  let token: string;
  try {
    token = decodeURIComponent(tokenMatch[1]);
  } catch {
    return null;
  }

  const slug = slugify(token);
  if (!slug) return null;

  const host = parsed.hostname.toLowerCase();
  if (host === "pay.ldxp.cn" || host === "www.ldxp.cn") return `ldxp-${slug}`;
  if (host === "pay.qxvx.cn") return `qxvx-${slug}`;
  if (host === "catfk.com" || host === "www.catfk.com") return `catfk-${slug}`;
  return null;
}
