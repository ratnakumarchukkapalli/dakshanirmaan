-- Skeleton for every post_* function. Copy, rename, fill the marked sections.
-- Invariants this shape guarantees: draft-only, role-gated, period-locked,
-- DB-recomputed money, gapless numbering, balanced entry, audited.

CREATE OR REPLACE FUNCTION post_DOCTYPE(p_doc_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_doc      RECORD;
  v_role     app_role;
  v_entry_id uuid;
  v_doc_no   text;
  p_actor    uuid := auth.uid();   -- NEVER a parameter: a caller could pass any uuid
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'DN_FORBIDDEN'; END IF;
  -- 1. Lock the document; drafts only
  SELECT * INTO v_doc FROM DOCTYPE_TABLE WHERE id = p_doc_id FOR UPDATE;
  IF NOT FOUND OR v_doc.status <> 'draft' THEN
    RAISE EXCEPTION 'DN_NOT_DRAFT';
  END IF;

  -- 2. Role gate (user: sales invoices, receipts, advances <= 5000; else admin)
  SELECT role INTO v_role FROM app_users WHERE user_id = p_actor AND is_active;
  IF v_role IS NULL /* OR insufficient for this doc type */ THEN
    RAISE EXCEPTION 'DN_FORBIDDEN';
  END IF;

  -- 3. Period lock
  IF EXISTS (SELECT 1 FROM fiscal_periods
             WHERE month = date_trunc('month', v_doc.DOC_DATE_COL)::date
               AND is_locked) THEN
    RAISE EXCEPTION 'DN_PERIOD_LOCKED';
  END IF;

  -- 4. Recompute money from line snapshots (never trust client totals)
  --    tax split: place_of_supply = org.state_code -> CGST+SGST else IGST
  --    round-off: |grand - raw| must be < 0.51 else RAISE 'DN_UNBALANCED'

  -- 5. Assign number now (gapless per FY series)
  v_doc_no := next_doc_no('DOCTYPE_SOURCE', v_doc.DOC_DATE_COL);

  -- 6. Journal entry + lines (deferred trigger verifies balance)
  INSERT INTO journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  VALUES (v_doc.DOC_DATE_COL, /* narration */ NULL, 'DOCTYPE_SOURCE', p_doc_id, p_actor, now())
  RETURNING id INTO v_entry_id;
  -- INSERT journal_lines ... (party_id on control-account lines only)

  -- 6b. Stock movements if goods moved (base UOM; check negative stock)
  --     on-hand after OUT must be >= 0 else RAISE 'DN_NEGATIVE_STOCK'
  --     OUT valued at current weighted avg -> Dr cogs / Cr inventory lines above

  -- 7. Finalize document
  UPDATE DOCTYPE_TABLE
     SET status = 'posted', journal_entry_id = v_entry_id, DOC_NO_COL = v_doc_no
         /* , recomputed totals */
   WHERE id = p_doc_id;

  -- 8. Audit
  INSERT INTO audit_log (actor, action, entity, entity_id, after)
  VALUES (p_actor, 'post', 'DOCTYPE_TABLE', p_doc_id,
          jsonb_build_object('doc_no', v_doc_no, 'entry_id', v_entry_id));

  RETURN v_entry_id;
END;
$$;

-- After CREATE: REVOKE EXECUTE ON FUNCTION post_DOCTYPE(uuid) FROM public, anon;
--               GRANT  EXECUTE ON FUNCTION post_DOCTYPE(uuid) TO authenticated;
-- Every RAISE uses a DN_* prefix: DN_NOT_DRAFT, DN_FORBIDDEN, DN_PERIOD_LOCKED,
-- DN_NEGATIVE_STOCK, DN_CREDIT_LIMIT, DN_UNBALANCED, DN_VALIDATION:<detail>.
