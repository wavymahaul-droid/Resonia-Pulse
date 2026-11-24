import assert from "node:assert/strict";
import { test } from "node:test";
import { runReason } from "./runs";
import { aliasByLinkedinId, ownPosts } from "./sync";

const brand = { slug: "mahindragroup", name: "Mahindra Group" } as never;
const item = (extra: object) =>
  ({
    type: "post",
    id: "1",
    linkedinUrl: "u",
    query: { targetUrl: "https://www.linkedin.com/company/mahindragroup/" },
    author: {},
    ...extra,
  }) as never;

test("own posts: authored by the page, or collaboration posts it co-authored", () => {
  const own = item({ author: { universalName: "mahindragroup" } });
  // 8-9 Oct 2026: "#MyMahindraStory" posts the actor reports under the employee who started them.
  const collab = item({
    author: { universalName: null, name: "Aakriti Bansal", type: "profile" },
    header: {
      text: "Mahindra Group collaborated on this",
      imageLink: "https://www.linkedin.com/company/mahindragroup/?miniCompanyUrn=x",
    },
  });
  const tagged = item({ author: { universalName: null, name: "Someone" } });
  const otherCollab = item({
    author: {},
    header: { text: "Tata Motors collaborated on this", imageLink: "https://www.linkedin.com/company/tatamotors/" },
  });
  const otherPage = {
    ...(own as object),
    query: { targetUrl: "https://www.linkedin.com/company/bajaj-auto-ltd/" },
  } as never;
  assert.deepEqual(ownPosts([own, collab, tagged, otherCollab, otherPage], brand), [own, collab]);
});

test("run reason for the dashboard tooltip", () => {
  const names = new Map([["mahindragroup", "Mahindra Group"]]);
  assert.equal(runReason("success", "anything", names), null);
  assert.equal(
    runReason("partial", "No posts returned for: mahindragroup. No new comments on tracked pages", names),
    "No posts returned for Mahindra Group (retried once); catches up next run",
  );
  assert.equal(
    runReason(
      "partial",
      "Posts step failed after a retry (Error: Apify 502); posts catch up next run. Comments failed: timeout",
      names,
    ),
    "Posts step failed after a retry; posts catch up next run. Comments step failed; catches up next run",
  );
  assert.equal(runReason("partial", "Took posts 19s", names), null);
});

test("one LinkedIn post, one record: a changed link maps to the stored one", () => {
  const stored = [
    { post_url: "https://li/posts/a-111", linkedin_id: "111" },
    { post_url: "https://li/posts/old", linkedin_id: null },
  ];
  const fetched = [
    { post_url: "https://li/posts/a-111", linkedin_id: "111" }, // same link: nothing to do
    { post_url: "https://li/posts/renamed-111", linkedin_id: "111" }, // new link, stored id
    { post_url: "https://li/posts/b-222", linkedin_id: "222" }, // new post
    { post_url: "https://li/posts/b-222-again", linkedin_id: "222" }, // twice in one batch
  ];
  const alias = aliasByLinkedinId(fetched, stored);
  assert.deepEqual(
    [...alias],
    [
      ["https://li/posts/renamed-111", "https://li/posts/a-111"],
      ["https://li/posts/b-222-again", "https://li/posts/b-222"],
    ],
  );
});
