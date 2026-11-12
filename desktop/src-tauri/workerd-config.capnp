using Workerd = import "/workerd/workerd.capnp";

# Strictly localhost. The Tauri shell rewrites {PORT} at launch to a
# free random port so multiple installs on the same machine never
# collide.
const config :Workerd.Config = (
  services = [
    (name = "podWorker", worker = .podWorker),
    (name = "podDiskStore", disk = (path = "{DATA_DIR}", writable = true)),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:{PORT}", service = "podWorker"),
  ],
);

const podWorker :Workerd.Worker = (
  modules = [
    (name = "secure-worker", esModule = embed "{AIRLOCK_DIR}/secure-worker.js"),
    (name = "pod-do", esModule = embed "{AIRLOCK_DIR}/pod-do.js"),
    (name = "pod-signing-web", esModule = embed "{AIRLOCK_DIR}/pod-signing-web.js"),
    (name = "session-binding", esModule = embed "{AIRLOCK_DIR}/session-binding.js"),
    (name = "unlock-token", esModule = embed "{AIRLOCK_DIR}/unlock-token.js"),
    (name = "rate-limit", esModule = embed "{AIRLOCK_DIR}/rate-limit.js"),
    (name = "do-guards", esModule = embed "{AIRLOCK_DIR}/do-guards.js"),
    (name = "webauthn-server", esModule = embed "{AIRLOCK_DIR}/webauthn-server.js"),
    (name = "feedback-limits", esModule = embed "{AIRLOCK_DIR}/feedback-limits.js"),
    (name = "family-do", esModule = embed "{AIRLOCK_DIR}/family-do.js"),
    (name = "inbox-routes", esModule = embed "{AIRLOCK_DIR}/inbox-routes.js"),
  ],
  durableObjectNamespaces = [
    (name = "POD", className = "PersonalPodDO", uniqueKey = "forum-stack-desktop"),
    (name = "FAMILY", className = "FamilyDO", uniqueKey = "podlink-desktop-family"),
  ],
  durableObjectStorage = (localDisk = "podDiskStore"),
);
