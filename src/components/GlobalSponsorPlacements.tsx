"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { SponsoredPlacementPreview } from "@/components/SponsoredPlacementPreview";
import { SPONSOR_PLACEMENT_KINDS, type SponsorSettingsSummary } from "@/lib/sponsor-settings-shared";

const sponsorSettingsCacheKey = "priceai.sponsor-settings.summary.v1";
const sponsorSettingsCacheVersion = 1;
const sponsorSettingsCacheFreshAgeMs = 30 * 60 * 1000;
const sponsorSettingsCacheMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const sponsorCreativeStatuses = new Set(["draft", "live", "paused", "expired"]);
const sponsorTones = new Set(["green", "blue", "amber"]);

const topBannerExcludedPathPrefixes = [
  "/admin",
  "/support",
  "/guides/self-host-api-transit",
] as const;

const footerExcludedPathPrefixes = [
  "/admin",
  "/commercial",
  "/support",
  "/api-transit",
  "/guides/self-host-api-transit",
] as const;

export function GlobalSponsorPlacements({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [sponsorSettings, setSponsorSettings] = useState<SponsorSettingsSummary | null>(null);
  const [hasKnownSponsorSettings, setHasKnownSponsorSettings] = useState(false);

  const shouldHideTopBanner = matchesPathPrefix(pathname, topBannerExcludedPathPrefixes);
  const shouldHideFooter = matchesPathPrefix(pathname, footerExcludedPathPrefixes);
  const shouldFetchSponsorSettings = !shouldHideTopBanner || !shouldHideFooter;
  const shouldReserveTopBannerSpace = !shouldHideTopBanner && shouldFetchSponsorSettings && !hasKnownSponsorSettings;

  useEffect(() => {
    if (!shouldFetchSponsorSettings) return;

    let cancelled = false;

    const cachedSettings = readCachedSponsorSettings();
    if (cachedSettings) {
      queueMicrotask(() => {
        if (cancelled) return;
        setSponsorSettings(cachedSettings.settings);
        setHasKnownSponsorSettings(true);
      });
    }
    if (cachedSettings?.isFresh) {
      return () => {
        cancelled = true;
      };
    }

    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch("/api/sponsor-settings", { signal: controller.signal });
        if (!response.ok) return;

        const payload: unknown = await response.json();
        const settings = parseSponsorSettingsResponse(payload);
        if (!settings || cancelled) return;

        setSponsorSettings(settings);
        setHasKnownSponsorSettings(true);
        writeCachedSponsorSettings(settings);
      } catch {
        // Keep the last known good settings on transient network or parsing failures.
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [shouldFetchSponsorSettings]);

  return (
    <>
      {shouldHideTopBanner ? null : (
        <SponsoredPlacementPreview
          kind="topBanner"
          settings={sponsorSettings}
          reserveWhenEmpty={shouldReserveTopBannerSpace}
        />
      )}
      {children}
      {shouldHideFooter ? null : (
        <SponsoredPlacementPreview
          kind="listFooter"
          settings={sponsorSettings}
          className="mx-auto mb-8 w-[calc(100%-2.5rem)] max-w-[1500px] sm:w-[calc(100%-4rem)]"
        />
      )}
    </>
  );
}

function matchesPathPrefix(pathname: string, prefixes: readonly string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function parseSponsorSettingsResponse(payload: unknown): SponsorSettingsSummary | null {
  if (!isRecord(payload) || payload.ok !== true) return null;
  return isSponsorSettingsSummary(payload.settings) ? payload.settings : null;
}

function readCachedSponsorSettings(): { settings: SponsorSettingsSummary; isFresh: boolean } | null {
  if (typeof window === "undefined") return null;

  try {
    const rawValue = window.localStorage.getItem(sponsorSettingsCacheKey);
    if (!rawValue) return null;

    const payload: unknown = JSON.parse(rawValue);
    if (!isRecord(payload) || payload.version !== sponsorSettingsCacheVersion) {
      removeCachedSponsorSettings();
      return null;
    }
    if (typeof payload.savedAt !== "string") {
      removeCachedSponsorSettings();
      return null;
    }

    const savedAt = Date.parse(payload.savedAt);
    const cacheAgeMs = Date.now() - savedAt;
    if (!Number.isFinite(savedAt) || cacheAgeMs > sponsorSettingsCacheMaxAgeMs) {
      removeCachedSponsorSettings();
      return null;
    }

    const settings = payload.settings;
    if (!isSponsorSettingsSummary(settings)) {
      removeCachedSponsorSettings();
      return null;
    }

    return {
      settings,
      isFresh: cacheAgeMs <= sponsorSettingsCacheFreshAgeMs,
    };
  } catch {
    removeCachedSponsorSettings();
    return null;
  }
}

function writeCachedSponsorSettings(settings: SponsorSettingsSummary) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(sponsorSettingsCacheKey, JSON.stringify({
      version: sponsorSettingsCacheVersion,
      savedAt: new Date().toISOString(),
      settings,
    }));
  } catch {
    // localStorage may be unavailable in private or restricted browser contexts.
  }
}

function removeCachedSponsorSettings() {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(sponsorSettingsCacheKey);
  } catch {
    // localStorage may be unavailable in private or restricted browser contexts.
  }
}

function isSponsorSettingsSummary(value: unknown): value is SponsorSettingsSummary {
  const record = isRecord(value) ? value : null;
  if (!record) return false;
  if (typeof record.configured !== "boolean") return false;
  if (typeof record.tableReady !== "boolean") return false;
  if (typeof record.enabled !== "boolean") return false;
  if (!isNullableString(record.updatedAt) || !isNullableString(record.message)) return false;

  const placements = isRecord(record.placements) ? record.placements : null;
  if (!placements) return false;

  return SPONSOR_PLACEMENT_KINDS.every((kind) => isSponsorPlacementConfig(placements[kind]));
}

function isSponsorPlacementConfig(value: unknown) {
  const record = isRecord(value) ? value : null;
  if (!record || typeof record.enabled !== "boolean" || !Array.isArray(record.creatives)) return false;
  return record.creatives.every(isSponsorCreative);
}

function isSponsorCreative(value: unknown) {
  const record = isRecord(value) ? value : null;
  if (!record) return false;
  if (typeof record.id !== "string" || typeof record.title !== "string") return false;
  if (typeof record.description !== "string" || typeof record.targetUrl !== "string") return false;
  if (typeof record.enabled !== "boolean") return false;
  if (typeof record.status !== "string" || !sponsorCreativeStatuses.has(record.status)) return false;
  if (typeof record.tone !== "string" || !sponsorTones.has(record.tone)) return false;
  if (record.appendUtm !== undefined && typeof record.appendUtm !== "boolean") return false;

  return isNullableString(record.sponsorName) &&
    isNullableString(record.campaignId) &&
    isNullableString(record.imageUrl) &&
    isNullableString(record.visualTitle) &&
    isNullableString(record.visualMeta) &&
    isNullableString(record.label) &&
    isNullableString(record.startsAt) &&
    isNullableString(record.endsAt);
}

function isNullableString(value: unknown) {
  return value === null || value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
