/**
 * civic-client — talks to the shared FamilyDO over signed RPC for the PUBLIC,
 * server-readable civic layer (county boards + lobbies). Unlike family-client.js
 * there is NO end-to-end encryption here: these groups are server-readable by
 * design, so content is plaintext and there are no wrapped keys to manage.
 *
 * Identity is still a device Ed25519 key (auto-minted on first signed request by
 * pod-signing.js). Public signup = POST /register with a pseudonymous handle.
 */
import { signBundle } from "../pod-signing.js";
import { enrichSignedEnvelope } from "../signing-envelope.js";
import { COUNTIES } from "../config/instance.js";

export function apiRoot() {
  const override = (localStorage.getItem("podlink.familyRoot") || "").trim();
  const base = override || window.location.origin;
  return base.replace(/\/+$/, "").replace(/\/(family|pod)$/i, "").replace(/\/+$/, "");
}

export async function rpc(verb, path, data = null) {
  // `_n` makes every signed bundle unique so two identical requests in the same
  // millisecond (e.g. React StrictMode double-firing an effect) don't collide on
  // the DO's replay guard. The server ignores unknown payload fields.
  const signed = enrichSignedEnvelope(await signBundle({ verb, path, data, _n: crypto.randomUUID() }));
  const url = `${apiRoot()}/api/family${path === "/" ? "" : path}`;
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signed) });
  } catch (e) {
    throw new Error(`Network error (${url}): ${e.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.reason || body?.error || res.statusText);
    err.code = body?.error;
    err.status = res.status;
    throw err;
  }
  return body;
}
export const civicRpc = rpc;

// ---- onboarding ----------------------------------------------------------

export const bootstrap = () => rpc("GET", "/bootstrap");
export const getInstance = () => rpc("GET", "/instance");

/** Public signup: claim a pseudonymous handle. No real name, no ID. */
export const registerHandle = (handle) => rpc("POST", "/register", { handle });

/**
 * Found the instance (first device only). We provision the founder as the
 * instance steward, set OPEN public signup for the pilot, then seed the county
 * boards from config. No E2E family key is created — the civic layer is
 * server-readable.
 */
export async function foundInstance({ handle }) {
  const r = await rpc("PROVISION", "/", { instance_join_policy: "open", handle });
  await seedCounties();
  return r;
}
export const seedCounties = () => rpc("POST", "/counties/seed", { counties: COUNTIES });

// ---- groups (county boards + lobbies) ------------------------------------

export const listCounties = () => rpc("LIST", "/groups", { type: "county" });
export const listLobbies = (countyId) => rpc("LIST", "/groups", { type: "issue", parent_group_id: countyId });
export const getGroup = (id) => rpc("GET", `/groups/${id}`);
export const joinGroup = (id) => rpc("POST", `/groups/${id}/join`, {});
export const createLobby = ({ name, parentId, visibility = "public_read", joinPolicy = "open" }) =>
  rpc("POST", "/groups", { type: "issue", name, parent_group_id: parentId, visibility, join_policy: joinPolicy });

// ---- deliberation content + Pol.is signal --------------------------------

export const listPosts = (gid) => rpc("LIST", `/groups/${gid}/posts`);
export const createPost = (gid, text) => rpc("POST", `/groups/${gid}/posts`, { text });
export const listComments = (gid, pid) => rpc("LIST", `/groups/${gid}/posts/${pid}/comments`);
export const createComment = (gid, pid, text) => rpc("POST", `/groups/${gid}/posts/${pid}/comments`, { text });
/** Like (+1) / dislike (-1) / clear (0) — this is the agree/disagree signal. */
export const vote = (gid, itemType, itemId, v) => rpc("POST", `/groups/${gid}/vote`, { item_type: itemType, item_id: itemId, vote: v });
export const opinionMap = (gid) => rpc("GET", `/groups/${gid}/opinion-map`);
