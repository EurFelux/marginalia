import semver from "semver";
import type { UpdateCheckResult } from "@shared/ipc";
import { createLogger } from "@main/logger";

const log = createLogger("update");

/** 与 forge.config.ts PublisherGithub 一致；发布全为 draft+prerelease，故走 /releases 列表（匿名 API 自动过滤 draft、含 prerelease、按 created_at 降序）。 */
const REPO = { owner: "EurFelux", name: "marginalia" } as const;

interface GithubRelease {
  tag_name: string;
  html_url: string;
}

export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch,
  repo: { owner: string; name: string } = REPO,
): Promise<UpdateCheckResult> {
  try {
    const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/releases?per_page=10`;
    const res = await fetchImpl(url, {
      headers: {
        // GitHub API 缺 User-Agent 直接 403，务必带上。
        "User-Agent": "marginalia",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      return {
        status: "error",
        currentVersion,
        message: `GitHub API ${res.status} ${res.statusText}`,
      };
    }
    const releases = (await res.json()) as GithubRelease[];
    if (!Array.isArray(releases) || releases.length === 0) {
      return { status: "up-to-date", currentVersion, latestVersion: currentVersion };
    }
    const latestVersion = releases[0].tag_name.replace(/^v/, "");
    if (!semver.valid(latestVersion)) {
      return {
        status: "error",
        currentVersion,
        message: `unparseable release tag: ${releases[0].tag_name}`,
      };
    }
    if (semver.gt(latestVersion, currentVersion)) {
      return {
        status: "update-available",
        currentVersion,
        latestVersion,
        releaseUrl: releases[0].html_url,
      };
    }
    return { status: "up-to-date", currentVersion, latestVersion };
  } catch (err) {
    log.warn("update check failed", err);
    return {
      status: "error",
      currentVersion,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
