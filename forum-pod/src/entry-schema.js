export const ENTRY_PAGES = [
  { key: "overview", label: "Overview", field: "overview" },
  { key: "key_facts", label: "Key facts", field: "key_facts", list: true },
  { key: "context_history", label: "Context & history", field: "context_history" },
  { key: "considerations", label: "Considerations", field: "considerations" },
  { key: "sources_limits", label: "Sources & limits", field: "sources_limits" },
];

export const CONTEST_URL =
  import.meta.env.VITE_CONTEST_URL ||
  "https://github.com/forum-community/forum-ai-template/issues";
