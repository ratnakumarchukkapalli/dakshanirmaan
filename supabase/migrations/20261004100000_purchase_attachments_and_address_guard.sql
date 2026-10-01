-- Changes 21b (database half) and 27b.
--
-- 21b item 0  Purchases are owner-only end to end: only an owner (admin at aal2) may write DRAFT
--             purchase bills and their lines. Before this a counter session could insert, edit and
--             delete draft purchase rows through the REST API (it could never post them).
-- 21b item 1  Bill photos: table `attachments`, private Storage bucket `docs` (5 MB, jpeg/png/pdf),
--             owner-only Storage policies scoped to `purchase_invoice/<bill id>/<uuid>.<ext>`.
--             A POSTED bill's attachments are audit evidence: neither the row nor the file can be
--             deleted while the bill is posted (allowed while draft, or once cancelled).
-- 27b         party_addresses_guard becomes BEFORE INSERT OR UPDATE: a non-owner app session cannot
--             change a site's state, and can only add a site in the party's own state. Out-of-state
--             delivery sites are added by the owner (owner decision, 2026-09-26).
--
-- Nothing here touches posting math, numbering, stock or journal behaviour.

-- ============================================================
-- 1. Purchase drafts: owner-only writes (21b item 0)
-- ============================================================
-- SELECT stays as it was (select_active_members): reading purchase data by a counter session is the
-- separate, spec-accepted K-class question, not part of this change.

drop policy if exists insert_draft on purchase_invoices;
drop policy if exists update_draft on purchase_invoices;
drop policy if exists delete_draft on purchase_invoices;

create policy insert_draft on purchase_invoices for insert
  with check (is_active_member() and current_app_role() = 'admin' and status = 'draft');
create policy update_draft on purchase_invoices for update
  using (is_active_member() and current_app_role() = 'admin' and status = 'draft')
  with check (is_active_member() and current_app_role() = 'admin' and status = 'draft');
create policy delete_draft on purchase_invoices for delete
  using (is_active_member() and current_app_role() = 'admin' and status = 'draft');

drop policy if exists insert_draft on purchase_invoice_lines;
drop policy if exists update_draft on purchase_invoice_lines;
drop policy if exists delete_draft on purchase_invoice_lines;

create policy insert_draft on purchase_invoice_lines for insert
  with check (is_active_member() and current_app_role() = 'admin'
              and exists (select 1 from purchase_invoices h
                           where h.id = purchase_invoice_lines.invoice_id and h.status = 'draft'));
create policy update_draft on purchase_invoice_lines for update
  using (is_active_member() and current_app_role() = 'admin'
         and exists (select 1 from purchase_invoices h
                      where h.id = purchase_invoice_lines.invoice_id and h.status = 'draft'))
  with check (is_active_member() and current_app_role() = 'admin'
              and exists (select 1 from purchase_invoices h
                           where h.id = purchase_invoice_lines.invoice_id and h.status = 'draft'));
create policy delete_draft on purchase_invoice_lines for delete
  using (is_active_member() and current_app_role() = 'admin'
         and exists (select 1 from purchase_invoices h
                      where h.id = purchase_invoice_lines.invoice_id and h.status = 'draft'));

-- ============================================================
-- 2. attachments (21b item 1)
-- ============================================================
-- Polymorphic (entity, entity_id): today only 'purchase_invoice'. To add an entity later, widen
-- the entity CHECK, teach attachments_guard() and public.docs_object_ok() where that entity's rows
-- live and who may touch them, and add pgTAP — in a new migration.

create table attachments (
  id           uuid primary key default gen_random_uuid(),
  entity       text not null,
  entity_id    uuid not null,
  storage_path text not null,
  mime         text not null,
  bytes        int  not null,
  uploaded_by  uuid references auth.users,
  uploaded_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  constraint attachments_entity_check check (entity in ('purchase_invoice')),
  constraint attachments_mime_check check (mime in ('image/jpeg', 'image/png', 'application/pdf')),
  constraint attachments_bytes_check check (bytes between 1 and 5242880),
  constraint attachments_storage_path_key unique (storage_path),
  -- The server builds the path: <entity>/<entity id>/<uuid>.<ext>, extension matching the type.
  constraint attachments_storage_path_check check (
    storage_path ~ ('^' || entity || '/' || entity_id::text
                    || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf)$')
    and right(storage_path, 4) = case mime when 'image/jpeg' then '.jpg'
                                           when 'image/png'  then '.png'
                                           else '.pdf' end)
);

create index attachments_entity_idx on attachments (entity, entity_id);

alter table attachments enable row level security;

-- Owner-only (admin at aal2). No UPDATE policy: an attachment is replaced by delete + add.
create policy select_owner on attachments for select
  using (is_active_member() and current_app_role() = 'admin');
create policy insert_owner on attachments for insert
  with check (is_active_member() and current_app_role() = 'admin');
create policy delete_owner on attachments for delete
  using (is_active_member() and current_app_role() = 'admin');

revoke all on public.attachments from anon, authenticated;
grant select, insert, delete on public.attachments to authenticated;
grant insert, select, update, delete on public.attachments to service_role;

-- Stamps uploader and time from the session (the set_created_by convention, for this table's
-- column names), checks the bill and the stored file, and keeps posted evidence.
create or replace function public.attachments_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status doc_status;
  v_meta jsonb;
begin
  if tg_op = 'INSERT' then
    -- Not an owner: refuse before saying anything about the bill or the file (this trigger runs
    -- before RLS's check and as definer, so its messages must not be an existence oracle).
    if auth.uid() is not null and coalesce(current_app_role() = 'admin', false) = false then
      raise exception 'DN_FORBIDDEN';
    end if;
    if auth.uid() is not null then
      new.uploaded_by := auth.uid();
      new.uploaded_at := now();
    end if;

    if new.entity is distinct from 'purchase_invoice' then
      return new; -- not an entity yet: attachments_entity_check refuses the row
    end if;
    select status into v_status from purchase_invoices where id = new.entity_id;
    if not found then
      raise exception 'DN_VALIDATION:attachment_entity_missing';
    end if;
    if v_status = 'cancelled' then
      raise exception 'DN_VALIDATION:attachment_entity_cancelled';
    end if;

    -- The row is written after the upload: the file must be in the bucket, and where Storage
    -- recorded its size and type they must be what the row declares.
    select o.metadata into v_meta
      from storage.objects o
     where o.bucket_id = 'docs' and o.name = new.storage_path;
    if not found then
      raise exception 'DN_VALIDATION:attachment_object_missing';
    end if;
    if (v_meta ? 'size' and (v_meta->>'size')::bigint is distinct from new.bytes::bigint)
       or (v_meta ? 'mimetype' and v_meta->>'mimetype' is distinct from new.mime) then
      raise exception 'DN_VALIDATION:attachment_object_mismatch';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- No UPDATE grant for sessions; this covers service_role and the database owner too.
    raise exception 'DN_VALIDATION:attachment_immutable';
  end if;

  -- DELETE: a photo of a posted OR cancelled bill is audit evidence (a cancelled bill keeps its number
  -- and its history, and its photo explains it); only a draft's photos can be removed. Only an app
  -- session is held to it, so a database-owner maintenance job (no auth.uid()) can still clear rows by hand.
  if auth.uid() is not null and old.entity = 'purchase_invoice'
     and exists (select 1 from purchase_invoices where id = old.entity_id and status <> 'draft') then
    raise exception 'DN_VALIDATION:attachment_bill_posted';
  end if;
  return old;
end;
$$;

revoke all on function public.attachments_guard() from public, anon, authenticated, service_role;

create trigger attachments_guard before insert or update or delete on attachments
  for each row execute function public.attachments_guard();

-- A draft bill with photos cannot be deleted out from under them (that would orphan the rows and
-- the files): the app removes the photos first. Posted/cancelled bills cannot be deleted anyway.
create or replace function public.purchase_invoices_attachments_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from attachments where entity = 'purchase_invoice' and entity_id = old.id) then
    raise exception 'DN_VALIDATION:bill_has_attachments';
  end if;
  return old;
end;
$$;

revoke all on function public.purchase_invoices_attachments_guard() from public, anon, authenticated, service_role;

create trigger purchase_invoices_attachments_guard before delete on purchase_invoices
  for each row execute function public.purchase_invoices_attachments_guard();

-- ============================================================
-- 3. Storage: private bucket `docs` + owner-only object policies (21b item 1)
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('docs', 'docs', false, 5242880, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Decides whether an owner session may do p_op ('select' | 'insert' | 'delete') on the object
-- p_name in bucket `docs`. Only the server-built shape purchase_invoice/<bill id>/<uuid>.<ext>
-- for an existing bill passes; insert also needs the bill not cancelled, delete needs it to be a
-- draft (same rule as the attachments row). Invoker rights: the caller's own RLS applies.
create or replace function public.docs_object_ok(p_name text, p_op text)
returns boolean
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_parts text[];
  v_status doc_status;
begin
  if coalesce(current_app_role() = 'admin', false) = false then
    return false;
  end if;
  if p_name is null or p_name !~ ('^purchase_invoice/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                                  || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf)$') then
    return false;
  end if;
  v_parts := string_to_array(p_name, '/');
  select status into v_status from purchase_invoices where id = v_parts[2]::uuid;
  if not found then
    return false;
  end if;
  return case p_op
    when 'select' then true
    when 'insert' then v_status <> 'cancelled'
    when 'delete' then v_status = 'draft'
    else false
  end;
end;
$$;

revoke all on function public.docs_object_ok(text, text) from public, anon;
grant execute on function public.docs_object_ok(text, text) to authenticated;
grant execute on function public.docs_object_ok(text, text) to service_role;

drop policy if exists docs_owner_select on storage.objects;
drop policy if exists docs_owner_insert on storage.objects;
drop policy if exists docs_owner_delete on storage.objects;

create policy docs_owner_select on storage.objects for select to authenticated
  using (bucket_id = 'docs' and public.docs_object_ok(name, 'select'));
create policy docs_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'docs' and public.docs_object_ok(name, 'insert'));
create policy docs_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'docs' and public.docs_object_ok(name, 'delete'));
-- No UPDATE policy: an object is never overwritten or moved (upload with upsert = false).

-- ============================================================
-- 3b. Freight vouchers tied to a bill (21b item 4): the link is owner-only and the bill must be posted
-- ============================================================

create or replace function public.expense_vouchers_bill_link_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status doc_status;
begin
  if new.purchase_invoice_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.purchase_invoice_id is not distinct from old.purchase_invoice_id then
    return new;
  end if;
  -- Counter staff may write expense vouchers (advances) but not tie one to a supplier bill: the
  -- owner's freight card would show it as that bill's freight.
  if auth.uid() is not null and coalesce(current_app_role() = 'admin', false) = false then
    raise exception 'DN_FORBIDDEN';
  end if;
  select status into v_status from purchase_invoices where id = new.purchase_invoice_id;
  if not found or v_status <> 'posted' then
    raise exception 'DN_VALIDATION:freight_bill_not_posted';
  end if;
  return new;
end;
$$;

revoke all on function public.expense_vouchers_bill_link_guard() from public, anon, authenticated, service_role;

create trigger expense_vouchers_bill_link_guard before insert or update on expense_vouchers
  for each row execute function public.expense_vouchers_bill_link_guard();

-- ============================================================
-- 4. party_addresses_guard: state is owner-only (27b)
-- ============================================================

create or replace function public.party_addresses_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- coalesce: a signed-in person with no active membership (or an admin below aal2) has no
  -- role — that must count as "not an admin", never as "unknown, so allow".
  v_counter bool := auth.uid() is not null and coalesce(current_app_role() = 'admin', false) = false;
  v_party_state text;
begin
  if tg_op = 'UPDATE' then
    -- An address belongs to one party for life; default_site_id and every invoice snapshot assume it.
    if new.party_id is distinct from old.party_id then
      raise exception 'DN_VALIDATION:address_party_locked';
    end if;
    -- The site's state decides CGST+SGST vs IGST at posting: owner-only once the site exists.
    if v_counter and new.state_code is distinct from old.state_code then
      raise exception 'DN_VALIDATION:admin_only_field';
    end if;
    return new;
  end if;

  -- INSERT: a counter user may add a site in the party's own state only.
  if v_counter then
    select state_code into v_party_state from parties where id = new.party_id;
    if v_party_state is null or new.state_code is distinct from v_party_state then
      raise exception 'DN_VALIDATION:admin_only_field';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.party_addresses_guard() from public, anon, authenticated, service_role;

drop trigger if exists party_addresses_guard on party_addresses;
create trigger party_addresses_guard before insert or update on party_addresses
  for each row execute function public.party_addresses_guard();
