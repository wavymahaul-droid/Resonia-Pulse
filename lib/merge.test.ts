import assert from "node:assert/strict";
import { test } from "node:test";
import { exportMediaType, samePost } from "./liexport";
import { exportMerges } from "./merge";

const synced = (id: string, text: string, posted_at: string, brand_id = "montraelectric") => ({
  post_url: `https://www.linkedin.com/posts/montraelectric_x-activity-${id}-abcd`,
  brand_id,
  linkedin_id: id,
  posted_at,
  text,
});
const fromExport = (id: string, text: string, day: string, brand_id = "montraelectric") => ({
  post_url: `https://www.linkedin.com/feed/update/urn:li:ugcPost:${id}`,
  brand_id,
  linkedin_id: id,
  posted_at: `${day}T12:00:00+05:30`,
  text,
  theme: "Other",
  theme_manual: false,
});

test("export posts fold into the synced post: same id, or same opening text within a day", () => {
  const a = synced(
    "7512745907554205697",
    "Another step forward in electrifying mid-mile logistics. Full text…",
    "2026-10-05T05:30:00Z",
  );
  const b = synced(
    "7511639032452349952",
    "Gandhi Ji showed us that meaningful change begins with conscious choices.",
    "2026-10-02T04:11:00Z",
  );
  const sameId = fromExport("7512745907554205697", "Another step forward", "2026-10-05");
  const sameText = fromExport("7511639030000000000", "Gandhi Ji showed us that meaningful change", "2026-10-02");
  const otherDay = fromExport("7400000000000000001", "Gandhi Ji showed us that meaningful change", "2026-09-20");
  const otherPage = fromExport(
    "7400000000000000002",
    "Gandhi Ji showed us that meaningful change",
    "2026-10-02",
    "montraelectrictruck",
  );
  assert.deepEqual(
    exportMerges([sameId, sameText, otherDay, otherPage], [a, b]).map((m) => [m.from.linkedin_id, m.to.linkedin_id]),
    [
      ["7512745907554205697", "7512745907554205697"],
      ["7511639030000000000", "7511639032452349952"],
    ],
  );
  // Two synced posts with the same opening text the same day: left alone rather than guessed.
  const twin = { ...b, post_url: `${b.post_url}-2`, linkedin_id: "7511639032452349999" };
  assert.equal(exportMerges([sameText], [b, twin]).length, 0);
  // Too little text to compare.
  assert.equal(samePost(fromExport("1", "Hi", "2026-10-02"), synced("2", "Hi", "2026-10-02T04:00:00Z")), false);
});

test("export content types map to the tracker's media types", () => {
  assert.deepEqual(["Image", "Video", "Document", "Carousel", "Article", "Text", null].map(exportMediaType), [
    "image",
    "video",
    "document",
    "document",
    "article",
    "text",
    "text",
  ]);
});
