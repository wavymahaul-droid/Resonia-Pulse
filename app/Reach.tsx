"use client";

import { createContext, useContext } from "react";
import type { DashPost } from "@/lib/dashboard";
import { fmtInt } from "@/lib/metrics";
import {
  CLICKS_NOT_PUBLIC,
  NOT_PUBLIC,
  VIDEO_CTR_NOTE,
  engagementsOf,
  fmtCtr,
  fmtImpressions,
  isVideo,
  publicInteractions,
} from "@/lib/reach";

// "from LinkedIn export, last uploaded …" for every ReachLine under it.
export const LiLabelContext = createContext("from LinkedIn export");

// Impressions, CTR and engagements on a post card. Resonia posts: from the uploaded LinkedIn export
// (`label` says when it was last uploaded). Competitors: only public interactions, since LinkedIn
// does not publish their impressions or clicks.
export function ReachLine({ post, montra, label }: { post: DashPost; montra: boolean; label?: string }) {
  const fromContext = useContext(LiLabelContext);
  label ??= fromContext;
  if (!montra) {
    return (
      <div className="reach-line muted" title={CLICKS_NOT_PUBLIC}>
        <span>
          <strong>{fmtInt(publicInteractions(post))}</strong> public interactions
        </span>
        <span>impressions, clicks: {NOT_PUBLIC}</span>
      </div>
    );
  }
  if (!post.li) {
    return (
      <div className="reach-line muted" title={label}>
        Impressions, CTR and engagements: not in an uploaded export yet
      </div>
    );
  }
  const video = isVideo(post);
  return (
    <div className="reach-line" title={label}>
      <span>
        <strong>{fmtImpressions(post.li.impressions)}</strong> impressions
      </span>
      <span title={video ? VIDEO_CTR_NOTE : undefined}>
        <strong>{fmtCtr(post.li.ctr)}</strong> CTR{video ? "*" : ""}
      </span>
      <span title="Reactions + comments + reposts + clicks">
        <strong>{fmtImpressions(engagementsOf(post.li))}</strong> engagements
      </span>
      <span title="LinkedIn's engagement rate, from the export">
        <strong>{fmtCtr(post.li.engagementRate)}</strong> eng. rate
      </span>
      <span className="reach-src">LinkedIn export</span>
      {video && <span className="reach-note muted small">* {VIDEO_CTR_NOTE}</span>}
    </div>
  );
}

// Where a post record came from, when it is not the daily sync.
export function OriginTag({ post }: { post: Pick<DashPost, "origin" | "ad"> }) {
  if (post.ad)
    return (
      <span
        className="tag origin-tag"
        title="A paid ad (Direct Sponsored Content) known only from an uploaded LinkedIn export: it never appeared on the page's feed, so it is left out of every post list and stat."
      >
        Ad (not on feed)
      </span>
    );
  if (post.origin === "export")
    return (
      <span
        className="tag origin-tag"
        title="Known only from an uploaded LinkedIn export: opening text and date, no posting time or image. Merged into the full post if the daily sync finds it."
      >
        from LinkedIn export
      </span>
    );
  if (post.origin === "backfill")
    return (
      <span
        className="tag origin-tag"
        title="Collected once for older dates: likes, comments and reposts are the totals on the day it was collected, not tracked daily."
      >
        historical totals
      </span>
    );
  return null;
}
