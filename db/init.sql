CREATE EXTENSION IF NOT EXISTS vector;

ALTER ROLE wx_semantic_search PASSWORD :'wxpw';

CREATE TABLE messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  created_at timestamptz NOT NULL,
  sender text NOT NULL,
  sender_display_name text,
  sort_sequence bigint NOT NULL,
  body text NOT NULL,
  embedding vector(__DIM__) NOT NULL
);

CREATE INDEX messages_conversation_sort_idx
  ON messages (conversation_id, sort_sequence, created_at, id);

CREATE INDEX messages_conversation_created_idx
  ON messages (conversation_id, created_at);

CREATE INDEX messages_embedding_idx
  ON messages USING hnsw (embedding vector_cosine_ops);

CREATE FUNCTION search_messages(
  query_embedding vector,
  filter_conversation text,
  filter_since timestamptz,
  filter_until timestamptz,
  match_limit integer
)
RETURNS TABLE (
  id text,
  conversation_id text,
  created_at timestamptz,
  sender text,
  sender_display_name text,
  sort_sequence bigint,
  body text,
  distance double precision
)
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
  PERFORM set_config('hnsw.ef_search', GREATEST(match_limit, 40)::text, true);
  PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  RETURN QUERY
  SELECT
    m.id,
    m.conversation_id,
    m.created_at,
    m.sender,
    m.sender_display_name,
    m.sort_sequence,
    m.body,
    m.embedding <=> query_embedding AS distance
  FROM messages m
  WHERE (filter_conversation IS NULL OR m.conversation_id = filter_conversation)
    AND (filter_since IS NULL OR m.created_at >= filter_since)
    AND (filter_until IS NULL OR m.created_at <= filter_until)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_limit;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO wx_semantic_search;
GRANT EXECUTE ON FUNCTION search_messages TO wx_semantic_search;
