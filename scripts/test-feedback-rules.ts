import {
  categoryFeedbackMatchesCurrentClassification,
  AFTERSALES_FEEDBACK_REASON,
  buildInitialFeedbackVerificationResult,
  countFeedbackImageEvidenceReferences,
  feedbackRequiresContact,
  feedbackRequiresEvidence,
  feedbackRequiresImageEvidence,
  hasFeedbackImageEvidenceReference,
  inferSuggestedActionForFeedback,
  isFeedbackImageEvidenceReference,
  MODEL_PRECHECK_FEEDBACK_REASONS,
  shouldCreateFeedbackVerification,
} from "../src/lib/trust-risk.js";
import type { OfferFeedbackReason } from "../src/lib/types.js";
import { sourceIdFromShopUrl } from "../src/lib/shop-source-search.js";

const optionalEvidenceReasons: OfferFeedbackReason[] = [
  "wrong_price",
  "item_removed",
  "stock_mismatch",
  "wrong_category",
  "other",
];

for (const reason of optionalEvidenceReasons) {
  assertEqual(feedbackRequiresEvidence(reason, "hide_offer"), false, `${reason} should not require evidence when user suggests hiding the offer`);
  assertEqual(feedbackRequiresEvidence(reason, "hide_source"), false, `${reason} should not require evidence when user suggests hiding the source`);
  assertEqual(feedbackRequiresImageEvidence(reason, "hide_offer"), false, `${reason} should not require image evidence`);
  assertEqual(feedbackRequiresContact(reason), false, `${reason} should not require contact`);
}

assertEqual(feedbackRequiresEvidence("description_mismatch", "unsure"), true, "description_mismatch should require evidence");
assertEqual(feedbackRequiresImageEvidence("description_mismatch", "unsure"), true, "description_mismatch should require image evidence");
assertEqual(feedbackRequiresContact("description_mismatch"), false, "description_mismatch should not require contact");
assertEqual(inferSuggestedActionForFeedback("description_mismatch"), "todo", "description_mismatch should go to manual review");
assertEqual(shouldCreateFeedbackVerification("description_mismatch", "标题党", "商品页截图"), false, "description_mismatch should not enter transient verification");
assertEqual(MODEL_PRECHECK_FEEDBACK_REASONS.has("description_mismatch"), true, "description_mismatch should support risk precheck");

assertEqual(categoryFeedbackMatchesCurrentClassification({
  snapshotProductId: "chatgpt-plus",
  currentProductId: "openai-phone-verification",
}), true, "legacy category feedback should close when classification changes");
assertEqual(categoryFeedbackMatchesCurrentClassification({
  expectedProductId: "grok-account",
  snapshotProductId: "super-grok",
  currentProductId: "grok-account",
}), true, "category feedback should close when the expected product matches");
assertEqual(categoryFeedbackMatchesCurrentClassification({
  issueDimension: "filter_tag",
  snapshotProductId: "chatgpt-plus",
  currentProductId: "openai-phone-verification",
}), false, "filter-tag feedback should not close from product reclassification");
assertEqual(
  buildInitialFeedbackVerificationResult({ reason: "description_mismatch", evidenceText: "商品标题和实际权益不一致" }),
  null,
  "description_mismatch should not create a recollection result",
);

const highRiskReasons: OfferFeedbackReason[] = [
  AFTERSALES_FEEDBACK_REASON,
  "fraud",
  "bad_source",
];

for (const reason of highRiskReasons) {
  assertEqual(feedbackRequiresEvidence(reason, "unsure"), true, `${reason} should require evidence`);
  assertEqual(feedbackRequiresImageEvidence(reason, "unsure"), true, `${reason} should require image evidence`);
  assertEqual(feedbackRequiresContact(reason), true, `${reason} should require contact`);
  assertEqual(MODEL_PRECHECK_FEEDBACK_REASONS.has(reason), true, `${reason} should support risk precheck`);
}

assertEqual(inferSuggestedActionForFeedback("wrong_price"), "recollect", "wrong_price should still suggest recollection");
assertEqual(shouldCreateFeedbackVerification("item_removed"), true, "item_removed should still enter link verification");
assertEqual(shouldCreateFeedbackVerification("stock_mismatch"), true, "stock_mismatch should still enter link verification");

const legacyImageReference = "r2://feedback-evidence/feedback/2026/07/1485f294-feae-4c77-998f-a4ccad012539.png";
const draftImageReference = "r2://feedback-evidence/feedback-drafts/1485f294-feae-4c77-998f-a4ccad012539/98e8d80f-03c9-460c-a134-c5f094b9f7d2/77f4c098-8408-40c8-a3bb-2459335624f7.webp";
assertEqual(isFeedbackImageEvidenceReference(legacyImageReference), true, "legacy bound feedback image reference should count as image evidence");
assertEqual(isFeedbackImageEvidenceReference(draftImageReference), true, "uploaded draft feedback image reference should count as image evidence before binding");
assertEqual(hasFeedbackImageEvidenceReference([draftImageReference]), true, "draft image references should satisfy high-risk image evidence checks");
assertEqual(countFeedbackImageEvidenceReferences([draftImageReference, "https://example.com/evidence.png"]), 1, "only managed image references should count as image evidence");

assertEqual(
  sourceIdFromShopUrl("https://pay.ldxp.cn/shop/PAXOVOVJ"),
  "ldxp-paxovovj",
  "LDXP shop URLs should resolve to their source ID",
);
assertEqual(
  sourceIdFromShopUrl("https://www.ldxp.cn/shop/PAXOVOVJ/?utm_source=priceai"),
  "ldxp-paxovovj",
  "LDXP shop URL variants should resolve to the same source ID",
);
assertEqual(sourceIdFromShopUrl("https://pay.qxvx.cn/shop/DemoShop"), "qxvx-demoshop", "QXVX shop URLs should resolve to their source ID");
assertEqual(sourceIdFromShopUrl("https://catfk.com/shop/DemoShop"), "catfk-demoshop", "CatFK shop URLs should resolve to their source ID");
assertEqual(sourceIdFromShopUrl("https://pay.ldxp.cn/item/thkc0p"), null, "product URLs should not broaden feedback search");
assertEqual(sourceIdFromShopUrl("奥特曼严选"), null, "plain search text should keep the existing text search behavior");

console.log("feedback rules test passed");

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}
