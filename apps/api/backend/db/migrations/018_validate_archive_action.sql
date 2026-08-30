-- 018_validate_archive_action.sql
-- Adds the 'validate_archive' action to the annotations CHECK constraint.
-- Used by the Archive Validation Pipeline (Layer B) to record human labels
-- on archive decisions: correct | incorrect | skip.

ALTER TABLE annotations DROP CONSTRAINT IF EXISTS annotations_action_check;
ALTER TABLE annotations ADD CONSTRAINT annotations_action_check CHECK (
    action IN (
        'override_status',
        'override_depth',
        'override_trivial',
        'clear_override',
        'note',
        'flag_for_review',
        'validate_archive'
    )
);
