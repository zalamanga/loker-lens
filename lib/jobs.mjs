import { Problem } from './errors.mjs';
import { truncateGraphemes } from '../public/model.mjs';

const LOOKBACK_MONTHS = 2;
const SOURCE_HOST = "www.disnakerja.com";
const SOURCE_TIME_ZONE_OFFSET_MS = 7 * 60 * 60 * 1000;

export const INTEREST_PROFILES = [
  {
    id: "it-web",
    name: "IT & Web Development",
    keywords: [
      "web developer",
      "frontend",
      "front end",
      "backend",
      "back end",
      "full stack",
      "software engineer",
      "programmer",
      "javascript",
      "typescript",
      "react",
      "vue",
      "angular",
      "html",
      "css",
      "php",
      "laravel",
      "wordpress",
      "ui ux",
      "website",
    ],
    weakKeywords: ["website"],
  },
  {
    id: "teknik-informatika",
    name: "Teknik Informatika",
    keywords: [
      "teknik informatika",
      "sistem informasi",
      "ilmu komputer",
      "teknik komputer",
      "informatika",
      "information technology",
      "computer science",
      "it support",
      "software engineer",
      "data engineer",
      "network engineer",
      "cyber security",
      "database",
      "server",
      "programmer",
    ],
    weakKeywords: ["database", "server"],
  },
  {
    id: "human-resources",
    name: "Human Resources",
    keywords: [
      "human resource",
      "human resources",
      "human capital",
      "hr",
      "hrd",
      "hrga",
      "hr ga",
      "people development",
      "people operations",
      "recruitment staff",
      "recruitment officer",
      "recruitment specialist",
      "recruitment and selection",
      "recruitment",
      "recruiter",
      "talent acquisition",
      "industrial relation",
      "hubungan industrial",
      "psikologi",
      "manajemen sdm",
      "sumber daya manusia",
      "personalia",
    ],
    weakKeywords: ["recruitment"],
  },
];

export function getLookbackStart(now = new Date(), months = LOOKBACK_MONTHS) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isSafeInteger(months) || months < 1 || months > 12) {
    throw new Problem('date_window', 'Jendela tanggal harus memakai waktu valid dan 1 sampai 12 bulan.');
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );
  const currentYear = Number(parts.year);
  const currentMonthIndex = Number(parts.month) - 1;
  const currentDay = Number(parts.day);
  const absoluteMonth = currentYear * 12 + currentMonthIndex - months;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonthIndex = ((absoluteMonth % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  const targetDay = Math.min(currentDay, daysInTargetMonth);
  return new Date(
    Date.UTC(targetYear, targetMonthIndex, targetDay, 0, 0, 0) - SOURCE_TIME_ZONE_OFFSET_MS
  );
}

export function decodeHtml(value = "") {
  const entities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    ndash: "–",
    mdash: "\u2014",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
  };

  return String(value)
    .replace(/&#(\d+);/g, (_, code) => scalar(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => scalar(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => entities[name.toLowerCase()] ?? match);
}

function scalar(code) {
  return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    ? String.fromCodePoint(code) : '\ufffd';
}

export function stripHtml(value = "") {
  return decodeHtml(
    String(value)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeJob(post, categoryMap, tagMap) {
  if (!post || typeof post !== 'object' || Array.isArray(post) || !Number.isSafeInteger(post.id) || post.id < 1) {
    throw new Problem('source_schema', 'Identitas post sumber tidak valid. Hasil terakhir tetap dipertahankan.');
  }
  const title = stripHtml(rendered(post.title, 20_000));
  const summary = stripHtml(rendered(post.excerpt, 20_000));
  if (!title.trim() || title.length > 500 || summary.length > 2000 || typeof post.slug !== 'string' || post.slug.length > 2000) {
    throw new Problem('source_schema', 'Judul, ringkasan atau slug sumber melampaui batas.');
  }
  const categories = taxonomy(post.categories, categoryMap);
  const locations = taxonomy(post.tags, tagMap);
  const sourceUrl = safeSourceUrl(post.link);
  if (!sourceUrl) throw new Problem('source_schema', 'Tujuan post tidak berada pada alamat sumber yang diizinkan.');
  const content = extractContent(rendered(post.content, 1_000_000));
  const searchableText = [
    title,
    summary,
    content.text,
  ].join(" ");

  return {
    id: post.id,
    title,
    summary,
    url: sourceUrl,
    slug: post.slug,
    publishedAt: normalizeDate(post.date),
    modifiedAt: normalizeDate(post.modified),
    categories: categories.map(({ id, name, slug }) => ({ id, name, slug })),
    locations: locations.map(({ id, name, slug }) => ({ id, name, slug })),
    content,
    matches: matchContent(searchableText),
  };
}

function rendered(value, maximum) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.rendered !== 'string' || value.rendered.length > maximum) {
    throw new Problem('source_schema', 'Teks post sumber tidak dapat diperiksa dalam batas aplikasi.');
  }
  return value.rendered;
}

function taxonomy(ids, terms) {
  if (!Array.isArray(ids) || ids.length > 200 || new Set(ids).size !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Problem('source_schema', 'Daftar kategori atau lokasi sumber tidak valid.');
  }
  return ids.map((id) => {
    const term = terms.get(id);
    if (!term) throw new Problem('source_schema', 'Kategori atau lokasi sumber berubah saat dibaca. Coba sinkronisasi lagi.');
    return term;
  });
}

export function extractContent(html = "") {
  const source = String(html);
  const hasDocumentAttachment =
    /href=["'][^"']+\.pdf(?:[?#][^"']*)?["']/i.test(source) ||
    /<(?:iframe|a)\b[^>]+(?:drive\.google\.com|docs\.google\.com)[^>]*>/i.test(source) ||
    /<(?:object|embed)\b/i.test(source);

  const safeHtml = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(iframe|object|embed)\b[^>]*\/?\s*>/gi, " ");

  const structuralLines = safeHtml
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<hr\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(p|li|h[1-6]|div|section|article|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const lines = decodeHtml(structuralLines)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 2)
    .filter((line) => !isBoilerplate(line));

  const headings = extractTaggedText(safeHtml, /<(?:h[2-6]|strong)\b[^>]*>([\s\S]*?)<\/(?:h[2-6]|strong)>/gi)
    .filter(isUsefulHeading)
    .slice(0, 12);
  const requirements = extractTaggedText(safeHtml, /<li\b[^>]*>([\s\S]*?)<\/li>/gi)
    .filter((line) => line.length >= 12 && line.length <= 260)
    .filter((line) => !isBoilerplate(line))
    .slice(0, 18);

  const joined = lines.join(' ');
  return {
    text: truncateGraphemes(joined, 18_000),
    truncated: joined.length > 18_000,
    headings: [...new Set(headings)],
    requirements: [...new Set(requirements)],
    hasDocumentAttachment,
  };
}

function extractTaggedText(html, pattern) {
  return [...html.matchAll(pattern)]
    .map((match) => stripHtml(match[1]))
    .filter(Boolean);
}

function isBoilerplate(line) {
  return /^(disclaimer|apply now|cara melamar|info lowongan lainnya)|t\.me\/disnakerja|tidak pernah memungut biaya/i.test(
    line.replace(/^•\s*/, "")
  );
}

function isUsefulHeading(line) {
  if (line.length < 3 || line.length > 120) return false;
  return !/^(lowongan kerja\b.*|requirements?|qualifications?|kualifikasi|job descriptions?|deskripsi pekerjaan|tugas dan tanggung jawab|disclaimer|apply now|cara melamar)$/i.test(
    line
  );
}

export function matchContent(value = "") {
  const normalized = normalizeSearchText(value);
  return INTEREST_PROFILES.map((profile) => {
    const keywords = profile.keywords.filter((keyword) => containsKeyword(normalized, keyword));
    const hasStrongSignal = keywords.some((keyword) => !(profile.weakKeywords || []).includes(keyword));
    return { id: profile.id, name: profile.name, keywords, count: keywords.length, hasStrongSignal };
  })
    .filter((profile) => profile.count > 0 && profile.hasStrongSignal)
    .map(({ hasStrongSignal, ...profile }) => profile);
}

function normalizeSearchText(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsKeyword(normalizedText, keyword) {
  const normalizedKeyword = normalizeSearchText(keyword);
  const literal = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9+#])${literal}(?=$|[^a-z0-9+#])`).test(normalizedText);
}

function normalizeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new Problem('source_schema', 'Tanggal lokal post sumber tidak valid.');
  }
  // The public API exposes the site's local time without an offset.
  const date = new Date(`${value}+07:00`);
  if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + SOURCE_TIME_ZONE_OFFSET_MS).toISOString().slice(0, 19) !== value) {
    throw new Problem('source_schema', 'Tanggal post sumber tidak merupakan tanggal kalender yang valid.');
  }
  return date.toISOString();
}

function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === SOURCE_HOST && !url.port && !url.username && !url.password) return url.href;
  } catch {
    // Invalid source URLs are intentionally discarded.
  }
  return null;
}

function toMap(terms) {
  if (!Array.isArray(terms) || terms.length > 2000 || terms.some((term) => !term || typeof term !== 'object' || Array.isArray(term)
      || !Number.isSafeInteger(term.id) || term.id < 1 || typeof term.name !== 'string' || term.name.length > 2000
      || typeof term.slug !== 'string' || !term.slug || term.slug.length > 2000
      || !Number.isSafeInteger(term.count) || term.count < 0) || new Set(terms.map((term) => term.id)).size !== terms.length) {
    throw new Problem('source_schema', 'Daftar istilah sumber tidak valid atau melampaui batas.');
  }
  return new Map(
    terms.map((term) => [
      Number(term.id),
      {
        id: Number(term.id),
        name: decodeHtml(term.name),
        slug: String(term.slug || ""),
        count: Number(term.count || 0),
      },
    ])
  );
}

function buildFacets(jobs) {
  const categoryCounts = new Map();
  const locationCounts = new Map();

  for (const job of jobs) {
    for (const category of job.categories) {
      const current = categoryCounts.get(category.slug) || { ...category, count: 0 };
      current.count += 1;
      categoryCounts.set(category.slug, current);
    }
    for (const location of job.locations) {
      const current = locationCounts.get(location.slug) || { ...location, count: 0 };
      current.count += 1;
      locationCounts.set(location.slug, current);
    }
  }

  const sorter = (a, b) => b.count - a.count || a.name.localeCompare(b.name, "id");
  return {
    categories: [...categoryCounts.values()].sort(sorter),
    locations: [...locationCounts.values()].sort(sorter),
  };
}


export { buildFacets, safeSourceUrl, toMap };
