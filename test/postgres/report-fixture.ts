export const authorId = "00000000-0000-0000-0000-000000000001";
export const reporterId = "00000000-0000-0000-0000-000000000002";
export const unknownId = "00000000-0000-0000-0000-000000000003";
export const deletedId = "00000000-0000-0000-0000-000000000004";
export const resolverId = "00000000-0000-0000-0000-000000000005";
export const reportId = "00000000-0000-0000-0000-000000000101";

export const reportFixtureSql = `
  DROP TABLE IF EXISTS moderation_audit, reports, members CASCADE;
  CREATE TABLE members (id uuid PRIMARY KEY, pseudonym text, deleted_at timestamptz);
  CREATE TABLE reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), room_id text NOT NULL DEFAULT 'campus-live',
    message_id text NOT NULL, reported_member_id uuid NOT NULL,
    reporter_member_id uuid REFERENCES members(id) ON DELETE CASCADE,
    message_snapshot text NOT NULL, reason text, status text NOT NULL DEFAULT 'open',
    resolved_by uuid REFERENCES members(id) ON DELETE SET NULL, resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reports_reported_member_id_members_id_fk FOREIGN KEY(reported_member_id) REFERENCES members(id) ON DELETE CASCADE,
    CONSTRAINT reports_message_reporter_uniq UNIQUE(message_id, reporter_member_id)
  );
  CREATE UNIQUE INDEX reports_auto_flag_uniq ON reports(room_id, message_id) WHERE reporter_member_id IS NULL;
  CREATE INDEX reports_status_created_idx ON reports(status, created_at);
  INSERT INTO members(id, pseudonym, deleted_at) VALUES
    ('${authorId}', 'grumpy-heron', NULL), ('${reporterId}', 'wise-seal', NULL),
    ('${unknownId}', NULL, NULL), ('${deletedId}', 'quiet-ibex', now()), ('${resolverId}', 'swift-heron', NULL);
  INSERT INTO reports(id, message_id, reported_member_id, reporter_member_id, message_snapshot, resolved_by) VALUES
    ('${reportId}', 'linked-message', '${authorId}', '${reporterId}', 'retained body', '${resolverId}'),
    ('00000000-0000-0000-0000-000000000102', 'unknown-message', '${unknownId}', '${reporterId}', 'unknown body', NULL),
    ('00000000-0000-0000-0000-000000000103', 'deleted-message', '${deletedId}', '${reporterId}', 'deleted author body', NULL);
`;
