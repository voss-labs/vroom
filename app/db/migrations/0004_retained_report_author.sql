ALTER TABLE reports ADD COLUMN IF NOT EXISTS author_handle text;

UPDATE reports
SET author_handle = members.pseudonym
FROM members
WHERE reports.reported_member_id = members.id
  AND reports.author_handle IS NULL
  AND members.pseudonym ~ '[^[:space:]]';

ALTER TABLE reports ALTER COLUMN reported_member_id DROP NOT NULL;

DO $migration$
DECLARE
  report_table regclass := format('%I.reports', current_schema())::regclass;
  target_column smallint;
  target_fk record;
BEGIN
  SELECT attnum INTO STRICT target_column
  FROM pg_catalog.pg_attribute
  WHERE attrelid = report_table
    AND attname = 'reported_member_id'
    AND NOT attisdropped;

  FOR target_fk IN
    SELECT conname
    FROM pg_catalog.pg_constraint
    WHERE conrelid = report_table
      AND contype = 'f'
      AND target_column = ANY(conkey)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', report_table, target_fk.conname);
  END LOOP;

  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT reports_reported_member_id_members_id_fk FOREIGN KEY (reported_member_id) REFERENCES %I.members(id) ON DELETE SET NULL',
    report_table, current_schema()
  );
END;
$migration$;

ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_retained_author;
ALTER TABLE reports ADD CONSTRAINT reports_retained_author
  CHECK (reported_member_id IS NOT NULL OR coalesce(author_handle ~ '[^[:space:]]', false));
