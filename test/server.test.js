import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeHtml,
  extractContent,
  getLookbackStart,
  matchContent,
  normalizeJob,
  stripHtml,
} from "../lib/jobs.mjs";

test("getLookbackStart uses a rolling calendar-month window in Jakarta time", () => {
  assert.equal(
    getLookbackStart(new Date("2026-10-02T12:00:00.000Z"), 2).toISOString(),
    "2026-08-01T17:00:00.000Z"
  );
  assert.equal(
    getLookbackStart(new Date("2026-05-31T05:00:00.000Z"), 1).toISOString(),
    "2026-04-29T17:00:00.000Z"
  );
});

test("decodeHtml handles named, decimal, and hexadecimal entities", () => {
  assert.equal(decodeHtml("Oil &amp; Gas &#8211; &#x41;"), "Oil & Gas – A");
});

test("stripHtml removes markup and normalizes whitespace", () => {
  assert.equal(stripHtml("<p>Halo <strong>pencari</strong> kerja&nbsp;!</p>"), "Halo pencari kerja !");
});

test("extractContent keeps useful headings and requirements but ignores embedded documents", () => {
  const content = extractContent(`
    <h3>Lowongan Kerja PT Contoh</h3>
    <p><strong>WEB DEVELOPER</strong></p>
    <ul><li>S1 Teknik Informatika dan menguasai Laravel</li></ul>
    <iframe src="https://drive.google.com/file/d/example/preview"></iframe>
    <p>Disclaimer</p>
  `);

  assert.equal(content.hasDocumentAttachment, true);
  assert.deepEqual(content.headings, ["WEB DEVELOPER"]);
  assert.deepEqual(content.requirements, ["S1 Teknik Informatika dan menguasai Laravel"]);
  assert.equal(content.text.includes("drive.google.com"), false);
});

test("matchContent identifies IT and HR profiles using whole keywords", () => {
  const matches = matchContent(
    "Dibutuhkan Web Developer lulusan Teknik Informatika serta HRD untuk proses recruitment."
  );

  assert.equal(matches.some((item) => item.id === "it-web"), true);
  assert.equal(matches.some((item) => item.id === "teknik-informatika"), true);
  assert.equal(matches.some((item) => item.id === "human-resources"), true);
  assert.equal(matchContent("Baca informasi rekrutmen pada website dan simpan ke database").length, 0);
});

test("normalizeJob maps categories and refuses an off-domain destination instead of inventing one", () => {
  const categories = new Map([[12, { id: 12, name: "Fresh Graduate", slug: "fresh-graduate" }]]);
  const tags = new Map([[14, { id: 14, name: "Jawa Barat", slug: "jawa-barat" }]]);
  const job = normalizeJob(
    {
      id: 99,
      title: { rendered: "PT Contoh &amp; Rekan" },
      excerpt: { rendered: "<p>Kesempatan baru</p>" },
      link: "https://www.disnakerja.com/jobs/99",
      content: { rendered: '<p>Kesempatan latihan untuk web developer.</p>' },
      slug: "pt-contoh",
      date: "2026-10-02T10:00:00",
      modified: "2026-10-02T11:00:00",
      categories: [12],
      tags: [14],
    },
    categories,
    tags
  );

  assert.equal(job.title, "PT Contoh & Rekan");
  assert.equal(job.url, "https://www.disnakerja.com/jobs/99");
  assert.equal(job.modifiedAt, "2026-10-02T04:00:00.000Z");
  assert.deepEqual(job.categories.map((item) => item.slug), ["fresh-graduate"]);
  assert.deepEqual(job.locations.map((item) => item.slug), ["jawa-barat"]);
  assert.throws(() => normalizeJob({ id: 99, title: { rendered: 'Contoh' }, excerpt: { rendered: '' }, slug: 'contoh', content: { rendered: '' }, categories: [], tags: [], link: 'https://evil.example/jobs/99', date: '2026-10-02T10:00:00', modified: '2026-10-02T11:00:00' }, categories, tags), (error) => error.code === 'source_schema');
});
