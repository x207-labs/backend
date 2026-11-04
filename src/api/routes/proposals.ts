import { ApiError, invalidRequest } from "../errors.js";
import { isoFromNs } from "../format.js";
import type { Route } from "../router.js";
import type { ViewFunction } from "../../settlement/intents.js";

/** Sputnik DAO v2 proposal status. */
export const PROPOSAL_STATUSES = ["InProgress", "Approved", "Rejected", "Removed", "Expired", "Moved", "Failed"] as const;

/** Shape of a proposal from the Sputnik DAO v2 `get_proposals` view (the part that is used). */
interface DaoProposal {
  id: number;
  proposer: string;
  description: string;
  status: string;
  submission_time: string;
  vote_counts?: Record<string, [number, number, number]>;
  kind: unknown;
}

const PAGE = 100;

/** `set_params` arguments of a `FunctionCall` proposal to the circle contract; `null` if the proposal is not `set_params`. */
export function decodeSetParams(kind: unknown, contractId: string): { params: unknown; gas: string; deposit: string } | null {
  const call = (kind as { FunctionCall?: { receiver_id?: string; actions?: { method_name: string; args: string; deposit: string; gas: string }[] } })?.FunctionCall;
  if (!call || call.receiver_id !== contractId) return null;
  const action = call.actions?.find((a) => a.method_name === "set_params");
  if (!action) return null;
  try {
    const decoded = JSON.parse(Buffer.from(action.args, "base64").toString("utf8")) as { params?: unknown };
    return { params: decoded.params ?? null, gas: action.gas, deposit: action.deposit };
  } catch {
    return { params: null, gas: action.gas, deposit: action.deposit };
  }
}

/**
 * BE-023, `GET /x207/circles/{circle}/proposals` (Spec API Backend 3.5): Sputnik DAO `set_params` proposals for the
 * circle contract, with status and vote counts. The DAO is the contract's `get_owner`. Read only; if the RPC or the DAO
 * fails, 502 `dao_unavailable`. The `status` parameter filters (400 for an unknown value). Loads at most the last 100
 * proposals of the DAO.
 */
export function proposalRoutes(view: ViewFunction): Route[] {
  return [
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/proposals",
      circleScoped: true,
      handler: async ({ circle, query }) => {
        const status = query.get("status");
        if (status !== null && !(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
          throw invalidRequest("unknown status", { status, allowed: PROPOSAL_STATUSES });
        }
        let dao: string;
        let proposals: DaoProposal[];
        try {
          dao = (await view(circle.contract_id, "get_owner", {})) as string;
          const last = Number(await view(dao, "get_last_proposal_id", {}));
          const from = Math.max(0, last - PAGE);
          proposals = (await view(dao, "get_proposals", { from_index: from, limit: PAGE })) as DaoProposal[];
        } catch (error) {
          throw new ApiError(502, "dao_unavailable", "DAO proposals could not be read", { upstream: error instanceof Error ? error.message : String(error) });
        }
        const items = proposals
          .map((p) => ({ p, call: decodeSetParams(p.kind, circle.contract_id) }))
          .filter((x) => x.call !== null && (status === null || x.p.status === status))
          .map(({ p, call }) => ({
            id: p.id,
            status: p.status,
            proposer: p.proposer,
            description: p.description,
            method: "set_params",
            params: call?.params ?? null,
            submittedAt: isoFromNs(BigInt(p.submission_time)),
            votes: p.vote_counts ?? {},
          }))
          .sort((a, b) => b.id - a.id);
        return { status: 200, body: { circle: circle.circle_id, dao, items, nextCursor: null } };
      },
    },
  ];
}
