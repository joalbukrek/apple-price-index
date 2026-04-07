export function decodeHtmlEntities(input = "") {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

export function stripHtml(input = "") {
  return decodeHtmlEntities(input)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeText(input = "") {
  return stripHtml(input)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function humanizeIdentifier(input = "") {
  if (/^m\d+(pro|max)?-\d+-\d+$/i.test(input)) {
    const [chip, cpu, gpu] = input.split("-");
    return `${humanizeIdentifier(chip)} ${cpu} CPU / ${gpu} GPU`;
  }

  if (/^\d+-\d+$/.test(input)) {
    const [cpu, gpu] = input.split("-");
    return `${cpu} CPU / ${gpu} GPU`;
  }

  if (/^\d+gb_per_second$/i.test(input)) {
    const speed = input.match(/^(\d+)gb_per_second$/i)?.[1];
    return `${speed}Gb Ethernet`;
  }

  return input
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\bwithactivenoisecancellation\b/gi, "With Active Noise Cancellation")
    .replace(/\bwithoutactivenoisecancellation\b/gi, "Without Active Noise Cancellation")
    .replace(/\bwificell\b/gi, "Wi-Fi + Cellular")
    .replace(/\bwificellular\b/gi, "Wi-Fi + Cellular")
    .replace(/\bwifi\b/gi, "Wi-Fi")
    .replace(/\bgpscell\b/gi, "GPS + Cellular")
    .replace(/\bgps\b/gi, "GPS")
    .replace(/\bspaceblack\b/gi, "Space Black")
    .replace(/\bnano texture\b/gi, "Nano Texture")
    .replace(/\bmidnight\b/gi, "Midnight")
    .replace(/\bstarlight\b/gi, "Starlight")
    .replace(/\bskyblue\b/gi, "Sky Blue")
    .replace(/\b(\d+)\s+(\d+)inch\b/gi, "$1.$2-inch")
    .replace(/\bairpods\b/gi, "AirPods")
    .replace(/\bmacbook\b/gi, "MacBook")
    .replace(/\biphone\b/gi, "iPhone")
    .replace(/\bipad\b/gi, "iPad")
    .replace(/\bimac\b/gi, "iMac")
    .replace(/\bmac\b/gi, "Mac")
    .replace(/\bm(\d+)\s*pro\b/gi, "M$1 Pro")
    .replace(/\bm(\d+)\s*max\b/gi, "M$1 Max")
    .replace(/\bm(\d+)\b/gi, "M$1")
    .replace(/\b(\d+)inch\b/gi, "$1-inch")
    .replace(/\b(\d+)gb\b/gi, "$1GB")
    .replace(/\b(\d+)tb\b/gi, "$1TB")
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\bCpu\b/g, "CPU")
    .replace(/\bGpu\b/g, "GPU")
    .replace(/\bUsb\b/g, "USB")
    .replace(/\bSsd\b/g, "SSD")
    .trim();
}

export function uniqueBy(items, selector) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const key = selector(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }

  return output;
}

export function formatMoney(amount, currency, maximumFractionDigits = 2) {
  if (amount == null || Number.isNaN(amount)) {
    return "";
  }

  if (!/^[A-Z]{3}$/.test(currency ?? "")) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits,
    }).format(amount);
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits,
  }).format(amount);
}

export function formatTry(amount) {
  if (amount == null || Number.isNaN(amount)) {
    return "";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDeltaTry(amount) {
  if (amount == null || Number.isNaN(amount)) {
    return "";
  }

  const sign = amount > 0 ? "+" : "";
  return `${sign}${formatTry(amount)}`;
}

function isCombiningCodePoint(codePoint) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint) {
  return (
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        codePoint === 0x303f ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
        (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd)))
  );
}

function charDisplayWidth(char) {
  const codePoint = char.codePointAt(0);
  if (codePoint == null || codePoint === 0 || isCombiningCodePoint(codePoint)) {
    return 0;
  }

  return isWideCodePoint(codePoint) ? 2 : 1;
}

function stringDisplayWidth(value) {
  let width = 0;

  for (const char of String(value ?? "")) {
    width += charDisplayWidth(char);
  }

  return width;
}

function sliceByDisplayWidth(value, maxWidth) {
  if (!maxWidth) {
    return "";
  }

  let width = 0;
  let output = "";

  for (const char of String(value ?? "")) {
    const charWidth = charDisplayWidth(char);
    if (width + charWidth > maxWidth) {
      break;
    }

    output += char;
    width += charWidth;
  }

  return output;
}

function padEndDisplayWidth(value, width) {
  const stringValue = String(value ?? "");
  const padding = width - stringDisplayWidth(stringValue);
  if (padding <= 0) {
    return stringValue;
  }

  return `${stringValue}${" ".repeat(padding)}`;
}

function truncate(value, maxWidth) {
  const stringValue = String(value ?? "");
  if (!maxWidth || stringDisplayWidth(stringValue) <= maxWidth) {
    return stringValue;
  }
  if (maxWidth <= 3) {
    return sliceByDisplayWidth(stringValue, maxWidth);
  }
  return `${sliceByDisplayWidth(stringValue, maxWidth - 3)}...`;
}

export function renderTable(rows, columns) {
  if (!rows.length) {
    return "No rows.";
  }

  const renderedRows = rows.map((row) =>
    columns.map((column) =>
      truncate(
        column.format ? column.format(row) : row[column.key] ?? "",
        column.maxWidth,
      ),
    ),
  );

  const widths = columns.map((column, index) =>
    Math.max(column.label.length, ...renderedRows.map((row) => stringDisplayWidth(row[index]))),
  );

  const header = columns
    .map((column, index) => padEndDisplayWidth(column.label, widths[index]))
    .join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const body = renderedRows
    .map((row) => row.map((cell, index) => padEndDisplayWidth(cell, widths[index])).join("  "))
    .join("\n");

  return `${header}\n${divider}\n${body}`;
}

export function parseCsv(value = "") {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
