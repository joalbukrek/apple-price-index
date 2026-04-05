import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CACHE_ROOT = join(homedir(), ".cache", "apple-price-index", "http");
const APPLE_THROTTLE_MIN_MS = 1400;
const APPLE_THROTTLE_MAX_MS = 3200;
const CURL_META_SENTINEL = "\n__APPLE_PRICE_INDEX_CURL_META__\t";
const CURL_CONNECT_TIMEOUT_SECONDS = 10;
const CURL_MAX_TIME_SECONDS = 45;
const MAX_HTTP_ATTEMPTS = 3;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 500, 502, 503, 504]);
const RETRYABLE_CURL_EXIT_CODES = new Set([6, 7, 18, 28, 35, 52, 55, 56, 92]);
let appleRequestQueue = Promise.resolve();
let nextAppleRequestAt = 0;
const httpStats = {
  logicalRequests: 0,
  cacheHits: 0,
  networkRequests: 0,
  appleNetworkRequests: 0,
  retries: 0,
  networkDurationMs: 0,
};

class HttpRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.requestUrl = details.requestUrl ?? null;
    this.httpStatus = details.httpStatus ?? null;
    this.contentType = details.contentType ?? null;
    this.curlExitCode = details.curlExitCode ?? null;
    this.isNotFound = Boolean(details.isNotFound);
    this.isAppleRejection = Boolean(details.isAppleRejection);
    this.isTransient = Boolean(details.isTransient);
    if (details.cause) {
      this.cause = details.cause;
    }
  }
}

class HttpStatusError extends HttpRequestError {}
class JsonParseError extends HttpRequestError {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickRandom(items) {
  return items[randomInt(items.length)];
}

function buildDynamicHeaderProfile() {
  const chromeVersion = pickRandom([
    "130.0.0.0",
    "129.0.0.0",
    "128.0.0.0",
    "127.0.0.0",
    "126.0.0.0",
  ]);
  const majorVersion = chromeVersion.split(".")[0];
  const windowsVersion = pickRandom([
    "Windows NT 10.0; Win64; x64",
    "Windows NT 10.0; WOW64",
    "Windows NT 11.0; Win64; x64",
  ]);
  const platform = pickRandom(["Windows", "Windows"]);
  const acceptLanguage = pickRandom([
    "en-US,en;q=0.9",
    "en-GB,en;q=0.9",
    "en-US,en;q=0.9,es;q=0.8",
    "en-US,en;q=0.8",
  ]);

  return {
    chromeVersion,
    majorVersion,
    windowsVersion,
    platform,
    acceptLanguage,
  };
}

const SESSION_HEADER_PROFILE = buildDynamicHeaderProfile();

function cachePathForRequest(url, accept) {
  const digest = createHash("sha1")
    .update(JSON.stringify({ url, accept }))
    .digest("hex");
  return join(CACHE_ROOT, `${digest}.json`);
}

function isAppleRequest(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.apple.com" || parsed.hostname === "www.apple.com.cn";
  } catch {
    return false;
  }
}

function generateDynamicHeaders(url, accept) {
  const parsed = new URL(url);
  const referer = `${parsed.origin}/`;

  return {
    "sec-ch-ua-platform": `"${SESSION_HEADER_PROFILE.platform}"`,
    "User-Agent": `Mozilla/5.0 (${SESSION_HEADER_PROFILE.windowsVersion}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${SESSION_HEADER_PROFILE.chromeVersion} Safari/537.36`,
    "sec-ch-ua": `"Chromium";v="${SESSION_HEADER_PROFILE.majorVersion}", "Google Chrome";v="${SESSION_HEADER_PROFILE.majorVersion}", "Not?A_Brand";v="99"`,
    "DNT": "1",
    "sec-ch-ua-mobile": "?0",
    "Accept": accept,
    "Accept-Language": SESSION_HEADER_PROFILE.acceptLanguage,
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Referer": referer,
    "Cache-Control": "max-age=0",
  };
}

function parseCurlExitCode(error) {
  if (typeof error?.code === "number") {
    return error.code;
  }

  const parsed = Number.parseInt(String(error?.code ?? ""), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseCurlOutput(output) {
  const markerIndex = output.lastIndexOf(CURL_META_SENTINEL);
  if (markerIndex === -1) {
    return {
      body: output,
      httpStatus: null,
      contentType: null,
    };
  }

  const body = output.slice(0, markerIndex);
  const metadata = output.slice(markerIndex + CURL_META_SENTINEL.length).trimEnd();
  const [httpStatusRaw = "", contentTypeRaw = ""] = metadata.split("\t");
  const parsedStatus = Number.parseInt(httpStatusRaw, 10);

  return {
    body,
    httpStatus: Number.isNaN(parsedStatus) || parsedStatus <= 0 ? null : parsedStatus,
    contentType: contentTypeRaw || null,
  };
}

function buildErrorDetails(url, { httpStatus = null, contentType = null, curlExitCode = null } = {}) {
  return {
    requestUrl: url,
    httpStatus,
    contentType,
    curlExitCode,
    isNotFound: httpStatus === 404,
    isAppleRejection: isAppleRequest(url) && [401, 403, 429].includes(httpStatus),
    isTransient:
      (httpStatus != null && RETRYABLE_HTTP_STATUSES.has(httpStatus)) ||
      (curlExitCode != null && RETRYABLE_CURL_EXIT_CODES.has(curlExitCode)),
  };
}

function createTransportError(url, error) {
  const curlExitCode = parseCurlExitCode(error);
  const parsed = parseCurlOutput(error?.stdout ?? "");
  const details = buildErrorDetails(url, {
    httpStatus: parsed.httpStatus,
    contentType: parsed.contentType,
    curlExitCode,
  });
  const message = error?.message || `Request failed for ${url}`;

  return new HttpRequestError(message, {
    ...details,
    cause: error,
  });
}

function createHttpStatusError(url, { httpStatus, contentType }) {
  const details = buildErrorDetails(url, { httpStatus, contentType });
  return new HttpStatusError(`Request failed with HTTP ${httpStatus} for ${url}`, details);
}

function createJsonParseError(url, body, contentType, cause) {
  return new JsonParseError(`Could not parse JSON response from ${url}`, {
    requestUrl: url,
    contentType,
    cause,
    isTransient: false,
    bodyPreview: body.slice(0, 200),
  });
}

function recordNetworkAttempt(url, durationMs) {
  httpStats.networkRequests += 1;
  httpStats.networkDurationMs += durationMs;
  if (isAppleRequest(url)) {
    httpStats.appleNetworkRequests += 1;
  }
}

function backoffDelayMs(attemptNumber) {
  const baseDelay = 750 * 2 ** (attemptNumber - 1);
  return baseDelay + randomInt(150, 451);
}

function shouldRetryRequest(error, attemptNumber) {
  return attemptNumber < MAX_HTTP_ATTEMPTS && error?.isTransient && !error?.isAppleRejection;
}

function snapshotResponseContentType(contentType) {
  return contentType?.split(";")[0]?.trim().toLowerCase() || null;
}

async function runWithAppleThrottle(url, task) {
  if (!isAppleRequest(url)) {
    return task();
  }

  const previous = appleRequestQueue;
  let releaseQueue;
  appleRequestQueue = new Promise((resolve) => {
    releaseQueue = resolve;
  });

  await previous;

  try {
    const waitMs = Math.max(0, nextAppleRequestAt - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    return await task();
  } finally {
    nextAppleRequestAt = Date.now() + randomInt(APPLE_THROTTLE_MIN_MS, APPLE_THROTTLE_MAX_MS + 1);
    releaseQueue();
  }
}

async function readCached(url, accept, maxAgeMs) {
  const cachePath = cachePathForRequest(url, accept);

  try {
    const [metadata, file] = await Promise.all([
      stat(cachePath),
      readFile(cachePath, "utf8"),
    ]);

    const payload = JSON.parse(file);
    const savedAtMs = Number.isNaN(Date.parse(payload?.savedAt ?? ""))
      ? metadata.mtimeMs
      : Date.parse(payload.savedAt);

    if (Date.now() - savedAtMs > maxAgeMs) {
      return null;
    }

    return {
      body: payload.body,
      contentType: payload.contentType ?? null,
    };
  } catch {
    return null;
  }
}

async function writeCached(url, accept, body, contentType) {
  const cachePath = cachePathForRequest(url, accept);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify(
      {
        url,
        accept,
        savedAt: new Date().toISOString(),
        contentType,
        body,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function fetchTextResponse(
  url,
  { refresh = false, cacheHours = 12, accept = "*/*" } = {},
) {
  const maxAgeMs = cacheHours * 60 * 60 * 1000;
  httpStats.logicalRequests += 1;

  if (!refresh) {
    const cached = await readCached(url, accept, maxAgeMs);
    if (cached != null) {
      httpStats.cacheHits += 1;
      return cached;
    }
  }

  const headers = generateDynamicHeaders(url, accept);
  const args = [
    "-L",
    "--silent",
    "--show-error",
    "--compressed",
    "--connect-timeout",
    String(CURL_CONNECT_TIMEOUT_SECONDS),
    "--max-time",
    String(CURL_MAX_TIME_SECONDS),
    "--write-out",
    `${CURL_META_SENTINEL}%{http_code}\t%{content_type}\n`,
  ];

  for (const [headerName, headerValue] of Object.entries(headers)) {
    args.push("-H", `${headerName}: ${headerValue}`);
  }

  args.push(url);

  for (let attempt = 1; attempt <= MAX_HTTP_ATTEMPTS; attempt += 1) {
    let stdout;
    const startedAt = Date.now();

    try {
      ({ stdout } = await runWithAppleThrottle(url, () =>
        execFileAsync("curl", args, {
          encoding: "utf8",
          maxBuffer: 20 * 1024 * 1024,
          timeout: (CURL_MAX_TIME_SECONDS + 5) * 1000,
        }),
      ));
    } catch (error) {
      recordNetworkAttempt(url, Date.now() - startedAt);

      const requestError = createTransportError(url, error);
      if (shouldRetryRequest(requestError, attempt)) {
        httpStats.retries += 1;
        await sleep(backoffDelayMs(attempt));
        continue;
      }

      throw requestError;
    }

    recordNetworkAttempt(url, Date.now() - startedAt);

    const response = parseCurlOutput(stdout);
    if (response.httpStatus != null && response.httpStatus >= 400) {
      const statusError = createHttpStatusError(url, {
        httpStatus: response.httpStatus,
        contentType: response.contentType,
      });

      if (shouldRetryRequest(statusError, attempt)) {
        httpStats.retries += 1;
        await sleep(backoffDelayMs(attempt));
        continue;
      }

      throw statusError;
    }

    const normalizedContentType = snapshotResponseContentType(response.contentType);
    await writeCached(url, accept, response.body, normalizedContentType);

    return {
      body: response.body,
      contentType: normalizedContentType,
    };
  }

  throw new HttpRequestError(`Request failed after ${MAX_HTTP_ATTEMPTS} attempts for ${url}`, {
    requestUrl: url,
  });
}

export async function fetchText(url, options) {
  const response = await fetchTextResponse(url, options);
  return response.body;
}

export async function fetchJson(url, options) {
  const response = await fetchTextResponse(url, {
    ...options,
    accept: "application/json",
  });

  if (response.contentType && !response.contentType.includes("json")) {
    throw new HttpRequestError(
      `Expected JSON from ${url}, received ${response.contentType}`,
      {
        requestUrl: url,
        contentType: response.contentType,
      },
    );
  }

  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw createJsonParseError(url, response.body, response.contentType, error);
  }
}

export function isAppleRejectionError(error) {
  return Boolean(error?.isAppleRejection);
}

export function isNotFoundError(error) {
  return Boolean(error?.isNotFound);
}

export function getHttpStatsSnapshot() {
  return { ...httpStats };
}
