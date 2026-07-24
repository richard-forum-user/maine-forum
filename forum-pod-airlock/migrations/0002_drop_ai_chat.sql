-- Handover 24: retire Kami chat quota/log tables (lazy-created by removed ai-chat.js)
DROP TABLE IF EXISTS ai_chat_quota;
DROP TABLE IF EXISTS ai_chat_log;
