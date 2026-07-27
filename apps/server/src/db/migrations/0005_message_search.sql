ALTER TABLE messages
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED;

CREATE INDEX messages_search_vector
  ON messages USING gin (search_vector);
