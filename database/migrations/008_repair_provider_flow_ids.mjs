export function up(pgm) {
  pgm.sql(`
    DO $$
    DECLARE
      target_table text;
      qualified_table text;
      largest_id bigint;
    BEGIN
      FOREACH target_table IN ARRAY ARRAY['scheduled_jobs', 'request_events']
      LOOP
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = target_table
            AND column_name = 'id' AND is_identity = 'NO' AND column_default IS NULL
        ) THEN
          qualified_table := format('%I.%I', current_schema(), target_table);
          EXECUTE format(
            'ALTER TABLE %s ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY',
            qualified_table
          );
          EXECUTE format('SELECT max(id) FROM %s', qualified_table) INTO largest_id;
          IF largest_id >= 1 THEN
            PERFORM setval(pg_get_serial_sequence(qualified_table, 'id'), largest_id, true);
          END IF;
        END IF;
      END LOOP;
    END $$;
  `);
}

// Some installations already have ID generation. Rolling back cannot safely remove it.
export const down = false;
