import { termsHash, type OfferPlan } from "@x207/core";

/**
 * F9 (CT-082): the leg that pays the seeker is named in the terms as `search_leg`, so the contract can hold it to
 * `max_search_share_bps`. `planOffer` leaves the field out; this adds it and recomputes `terms_hash`. A plan without a
 * seeker share (no seeker, or a share of 0 that makes no leg) is returned as it is.
 */
export function withSearchLeg(plan: OfferPlan, searcher: string | undefined): OfferPlan {
  if (plan.kind !== "bundle" || searcher === undefined) return plan;
  const leg = plan.terms.legs.find((l) => l.payee === searcher);
  if (leg === undefined) return plan;
  const terms = { ...plan.terms, search_leg: { payer: leg.payer, payee: searcher } };
  return { ...plan, terms, terms_hash: termsHash(terms) };
}
