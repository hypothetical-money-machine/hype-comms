ALTER TABLE conversations
  DROP CONSTRAINT conversations_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_check CHECK (
    (
      kind = 'channel'
      AND name IS NOT NULL
      AND char_length(btrim(name)) BETWEEN 1 AND 100
      AND slug IS NOT NULL
      AND slug = normalize(slug, NFKC)
      AND slug = lower(slug)
      AND char_length(slug) BETWEEN 1 AND 100
      AND slug !~ '(^-|-$|--)'
      AND dm_user_low_id IS NULL
      AND dm_user_high_id IS NULL
    )
    OR
    (
      kind = 'direct_message'
      AND name IS NULL
      AND slug IS NULL
      AND topic IS NULL
      AND dm_user_low_id IS NOT NULL
      AND dm_user_high_id IS NOT NULL
      AND dm_user_low_id::text < dm_user_high_id::text
      AND dm_user_low_id <> dm_user_high_id
      AND NOT is_archived
    )
  );
