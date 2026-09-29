# 21 — purchases-ui (split: 21a built, 21b open)

Skill: daksh-ui + daksh-api (21a, done); daksh-schema + daksh-api + daksh-ui (21b).
Spec section: frontend-architecture → `purchases/` (list tiles, bill form: supplier ref, ITC flag, RCM freight block, bill photo); api-architecture → `purchases.ts`, `attachments.ts` + "Uploads"; db-architecture → `attachments`, "RCM freight (change 04)"; security-deployment → Storage (bucket `docs` private, 5 MB, MIME allowlist).
Context: `post_purchase_invoice`, `cancel_document` and `v_open_purchase_invoices` existed since change 04; the screen was a placeholder. 21 is split because the attachment half adds a table, a Storage bucket and Storage RLS: that touches RLS, so it gets its own session and an Opus review, while the screens do not.

## 21a — built (Sonnet, 2026-09-29): list, bill form, posted view, post, cancel
See `implementation-notes.md`.

## 21b — open: bill photo + RCM freight block (Opus for the migration, Sonnet for the UI)
**Do not:** let a counter user upload to, read from or delete from `docs`; store a file without validating type and size on the server; serve a file by a public URL; write `journal_*` from the app.

0. **Also in this session (from the 21a Opus review): tighten RLS so only an owner can write DRAFT purchase rows** — replace `insert_draft`/`update_draft`/`delete_draft` on `purchase_invoices` and `purchase_invoice_lines` with `is_active_member() and current_app_role() = 'admin'`, pgTAP proving a `user` INSERT is refused; first grep the pgTAP fixtures and the demo data for counter-role purchase drafts.
1. **`attachments` table + `docs` bucket** (`entity text, entity_id uuid, storage_path text, mime text, bytes int, uploaded_by, uploaded_at`). Bucket private, 5 MB, MIME allowlist jpeg/png/pdf (enforced in the bucket config AND in the action). Storage RLS through `app_users` membership and `current_app_role()` (aal2-aware): purchases are owner-only, so the bucket's policies are owner-only for `entity = 'purchase_invoice'` paths; path built by the server (`purchase_invoice/<bill id>/<uuid>.<ext>`), never from the client's file name. The L1 catalog guard (`00026`) must stay green; new pgTAP for: counter refused (read, insert, delete), aal1 owner refused, wrong MIME/size refused, path outside the caller's entity refused, a posted bill's attachments cannot be deleted (audit) unless the bill is cancelled — decide and log.
2. **`attachments.ts`**: `getUploadUrl(entity, entityId, mime, bytes)` (owner-only, validates mime ∈ {jpeg, png, pdf}, bytes ≤ 5 MB, that the bill exists) returning a short-lived signed upload URL; the attachment row is written by a second action **after** the upload, which re-checks the object exists with the declared size; `deleteAttachment(id)`; a signed **read** URL for viewing (short-lived; never a public URL).
3. **UI:** bill photo on the bill form and the posted view (thumbnail/PDF link, phone camera capture `accept="image/*" capture`), remove while the bill is a draft; en + te.
4. **RCM freight block** (db spec "RCM freight (change 04)"): on a posted bill, "Add freight (reverse charge)" creates a linked `expense_vouchers` row (`party_id` = lorry owner, account `freight_inward`, `rcm = true`, `purchase_invoice_id`) and posts it with `post_expense_voucher` (intra-state GTA 5% split; inter-state or party-less transporter is refused `DN_VALIDATION:rcm_interstate`). Show the linked vouchers on the posted view. The staff screen has no freight voucher action today, so this is new.
5. **Purchases tile "rebate accrued"** waits for change 24 (brand rebates) — not part of 21b.

Done when: pgTAP for the bucket/table policies above; action tests (forbidden, wrong mime, oversize, missing object, happy path); real-browser walk on the local stack: upload a bill photo on a phone-width screen, open it, remove it, freight voucher posts and shows Dr freight / Dr input CGST+SGST / Cr rcm_payable; gates green.
