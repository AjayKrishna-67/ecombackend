-- ============================================================================
-- Attach Coimbatore postal codes to the `kaaikanidirect-coimbatore` channel
-- by reusing the existing PostalCode rows already linked to `ind-coimbatore`.
--
-- Strategy:
--   1. Look up the source channel id (ind-coimbatore) and the target
--      channel id (kaaikanidirect-coimbatore).
--   2. For every postal_code that (a) is in the list below AND (b) is
--      currently attached to ind-coimbatore, insert a row into the
--      postal_code_channels_channel join table linking it to the new
--      channel — but only if that link does not already exist (idempotent).
--   3. SELECT statements at the end report any codes that were missing
--      from ind-coimbatore so you can decide whether to create them.
--
-- Safe to re-run. Wrap in a transaction; rollback if the report looks wrong.
-- ============================================================================

START TRANSACTION;

-- ----------------------------------------------------------------------------
-- Resolve channel ids up-front (fail fast if either channel is missing).
-- ----------------------------------------------------------------------------
SET @src_channel_id := (SELECT id FROM channel WHERE token = 'ind-coimbatore' LIMIT 1);
SET @dst_channel_id := (SELECT id FROM channel WHERE token = 'kaaikanidirect-coimbatore' LIMIT 1);

SELECT
    @src_channel_id AS ind_coimbatore_channel_id,
    @dst_channel_id AS kaaikanidirect_coimbatore_channel_id;

-- If either is NULL the inserts below will no-op; abort manually in that case.

-- ----------------------------------------------------------------------------
-- Staging table holding the postal codes we want to attach.
-- ----------------------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS tmp_postal_codes;
CREATE TEMPORARY TABLE tmp_postal_codes (code VARCHAR(32) PRIMARY KEY);

INSERT INTO tmp_postal_codes (code) VALUES
  ('641001'),('641002'),('641003'),('641004'),('641005'),
  ('641006'),('641007'),('641008'),('641009'),('641010'),
  ('641011'),('641012'),('641013'),('641014'),('641017'),
  ('641018'),('641022'),('641024'),('641025'),('641026'),
  ('641027'),('641028'),('641029'),('641030'),('641034'),
  ('641035'),('641037'),('641038'),('641039'),('641041'),
  ('641044'),('641049'),('641046'),('641045'),('641042'),
  ('641048'),('631027'),('641015'),('641110'),('641023'),
  ('641021'),('641019'),('641036'),('641051'),('641105');

-- ----------------------------------------------------------------------------
-- Insert the join rows. Reuses the same PostalCode.id rows that
-- ind-coimbatore already points at, so the two channels share data.
-- ----------------------------------------------------------------------------
INSERT INTO postal_code_channels_channel (postalCodeId, channelId)
SELECT pc.id, @dst_channel_id
FROM postal_code pc
INNER JOIN postal_code_channels_channel src_link
        ON src_link.postalCodeId = pc.id
       AND src_link.channelId   = @src_channel_id
INNER JOIN tmp_postal_codes t
        ON t.code = pc.code
LEFT JOIN postal_code_channels_channel dst_link
        ON dst_link.postalCodeId = pc.id
       AND dst_link.channelId   = @dst_channel_id
WHERE dst_link.postalCodeId IS NULL;

SELECT ROW_COUNT() AS rows_inserted;

-- ----------------------------------------------------------------------------
-- Reports
-- ----------------------------------------------------------------------------

-- (a) Codes from the list that are NOT present in ind-coimbatore at all.
SELECT t.code AS missing_from_ind_coimbatore
FROM tmp_postal_codes t
LEFT JOIN (
    SELECT pc.code
    FROM postal_code pc
    INNER JOIN postal_code_channels_channel link
            ON link.postalCodeId = pc.id
           AND link.channelId   = @src_channel_id
) src ON src.code = t.code
WHERE src.code IS NULL;

-- (b) Final state for sanity-check: every code now linked to the new channel.
SELECT pc.code, pc.id AS postal_code_id
FROM postal_code pc
INNER JOIN postal_code_channels_channel link
        ON link.postalCodeId = pc.id
       AND link.channelId   = @dst_channel_id
INNER JOIN tmp_postal_codes t ON t.code = pc.code
ORDER BY pc.code;

DROP TEMPORARY TABLE IF EXISTS tmp_postal_codes;

-- Review the three result sets above, then COMMIT or ROLLBACK.
-- COMMIT;
-- ROLLBACK;
