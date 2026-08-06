ALTER TABLE tasks
  ADD COLUMN updated_by uuid;

UPDATE tasks
   SET updated_by = created_by;

-- The previous server remains supported during rolling deploys and omits updated_by on create.
-- Seed that additive column from its known creator until the compatibility window closes.
CREATE FUNCTION set_task_initial_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.updated_by IS NULL THEN
    NEW.updated_by := NEW.created_by;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_set_initial_actor
BEFORE INSERT ON tasks
FOR EACH ROW
EXECUTE FUNCTION set_task_initial_actor();

ALTER TABLE tasks
  ALTER COLUMN updated_by SET NOT NULL,
  ADD CONSTRAINT tasks_updated_by_membership_fk
    FOREIGN KEY (workspace_id, updated_by)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT;
