-- The Food Court: one migration for Postgres, RLS, stock, reports, and cron.
-- Enable pg_cron and pg_net in the Supabase dashboard before running this file
-- so the schedules at the bottom are created. Provider secrets are never stored here.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;

create table if not exists private.runtime_config (
  key text primary key,
  value text not null default ''
);

insert into private.runtime_config (key, value) values
  ('functions_base_url', ''),
  ('cron_secret', '')
on conflict (key) do nothing;

revoke all on schema private from public, anon, authenticated;
revoke all on table private.runtime_config from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Menu, students, orders, wallet
-- ---------------------------------------------------------------------------

create table public.menu_items (
  id text primary key,
  category text not null,
  name text not null,
  description text not null default '',
  price_cents integer not null check (price_cents >= 0),
  image text not null default '',
  popular boolean not null default false,
  available_days integer[] not null default '{}',
  special_on integer[] not null default '{}',
  badge text not null default '',
  sold_out boolean not null default false,
  portions integer,
  low_threshold integer not null default 5,
  sort integer not null default 0
);

create table public.students (
  id uuid primary key references auth.users (id) on delete cascade,
  student_number text not null unique,
  pin_hash text not null,
  full_name text not null,
  phone text not null,
  email text not null default '',
  balance_cents integer not null default 0 check (balance_cents >= 0),
  loyalty_stamps integer not null default 0 check (loyalty_stamps >= 0),
  nfc_uid text unique,
  auto_topup boolean not null default false,
  auto_topup_cents integer not null default 10000,
  low_balance_alerted_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.orders (
  id text primary key,
  order_number text not null,
  status text not null default 'received'
    check (status in ('received', 'preparing', 'ready', 'collected', 'cancelled', 'no_show')),
  customer_name text not null,
  phone text not null,
  pickup_time timestamptz not null,
  pickup_label text not null default '',
  notes text not null default '',
  item_count integer not null default 0,
  total_cents integer not null default 0,
  payment_method text not null check (payment_method in ('wallet', 'card', 'cash')),
  payment_status text not null
    check (payment_status in ('unpaid', 'pending', 'paid', 'refunded', 'written_off')),
  pay_on_collection boolean not null default true,
  student_id uuid references public.students (id),
  loyalty_redeemed boolean not null default false,
  discount_cents integer not null default 0,
  reminder_sent_at timestamptz,
  no_show_action_taken_at timestamptz,
  cancel_reason text,
  provider text,
  source text not null default 'web',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index orders_pickup_idx on public.orders (pickup_time);
create index orders_status_idx on public.orders (status);
create index orders_student_idx on public.orders (student_id);
create index orders_created_idx on public.orders (created_at);

create table public.order_items (
  id bigint generated always as identity primary key,
  order_id text not null references public.orders (id) on delete cascade,
  item_id text not null,
  name text not null,
  qty integer not null check (qty > 0),
  unit_price_cents integer not null,
  line_total_cents integer not null,
  loyalty_free_qty integer not null default 0
);

create index order_items_order_idx on public.order_items (order_id);

create table public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id),
  amount_cents integer not null check (amount_cents <> 0),
  balance_after_cents integer not null,
  kind text not null check (kind in ('topup', 'order', 'till', 'refund', 'adjust')),
  payment_method text,
  order_id text,
  provider text,
  provider_ref text,
  note text not null default '',
  created_at timestamptz not null default now()
);

create index wallet_ledger_student_idx on public.wallet_ledger (student_id, created_at desc);

create or replace function public.wallet_ledger_apply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bal integer;
begin
  select balance_cents into bal
  from public.students
  where id = new.student_id
  for update;
  if bal is null then
    raise exception 'Unknown wallet';
  end if;
  if bal + new.amount_cents < 0 then
    raise exception 'Insufficient wallet balance.';
  end if;
  update public.students
    set balance_cents = bal + new.amount_cents
    where id = new.student_id;
  new.balance_after_cents := bal + new.amount_cents;
  return new;
end;
$$;

create trigger wallet_ledger_apply
  before insert on public.wallet_ledger
  for each row execute function public.wallet_ledger_apply();

create table public.pay_tokens (
  token text primary key,
  student_id uuid not null references public.students (id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index pay_tokens_student_idx on public.pay_tokens (student_id);

create table public.email_codes (
  id bigint generated always as identity primary key,
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.daily_specials (
  id text primary key,
  special_date date not null,
  name text not null,
  price_cents integer not null,
  dow integer,
  day_label text not null default '',
  caption text not null default '',
  image_url text not null default '',
  source text not null default 'chef-page',
  status text not null default 'live',
  item_id text,
  created_at timestamptz not null default now()
);

create index daily_specials_date_idx on public.daily_specials (special_date desc);

create table public.app_settings (
  id integer primary key default 1 check (id = 1),
  data jsonb not null
);

-- ---------------------------------------------------------------------------
-- Stock
-- ---------------------------------------------------------------------------

create table public.suppliers (
  id text primary key,
  name text not null,
  phone text not null default '',
  email text not null default ''
);

create table public.ingredients (
  id text primary key,
  name text not null,
  unit text not null,
  cost_cents integer not null default 0,
  on_hand numeric(12, 3) not null default 0,
  reorder_level numeric(12, 3) not null default 0,
  supplier_id text references public.suppliers (id)
);

create table public.recipes (
  menu_item_id text not null references public.menu_items (id),
  ingredient_id text not null references public.ingredients (id),
  qty numeric(12, 3) not null check (qty > 0),
  primary key (menu_item_id, ingredient_id)
);

create table public.stock_movements (
  id bigint generated always as identity primary key,
  ingredient_id text,
  qty_delta numeric(12, 3) not null,
  reason text not null,
  note text not null default '',
  ref text not null default '',
  item_id text not null default '',
  created_at timestamptz not null default now()
);

create table public.goods_received (
  id bigint generated always as identity primary key,
  ingredient_id text not null,
  name text not null default '',
  qty numeric(12, 3) not null,
  cost_cents integer not null default 0,
  note text not null default '',
  created_at timestamptz not null default now()
);

create table public.waste_log (
  id bigint generated always as identity primary key,
  ingredient_id text not null default '',
  name text not null,
  qty numeric(12, 3) not null,
  unit text not null default '',
  cost_cents integer not null default 0,
  reason text not null default '',
  created_at timestamptz not null default now()
);

create table public.stock_takes (
  id bigint generated always as identity primary key,
  note text not null default '',
  lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.automation_runs (
  id bigint generated always as identity primary key,
  job text not null,
  status text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);

create table public.notifications (
  id bigint generated always as identity primary key,
  job text not null,
  channel text not null,
  recipient text not null default '',
  body text not null default '',
  sent boolean not null default false,
  skipped boolean not null default true,
  reason text not null default '',
  created_at timestamptz not null default now()
);

create table public.payment_intents (
  id text primary key,
  provider text not null,
  reference text not null,
  amount_cents integer not null,
  status text not null,
  kind text not null,
  order_id text,
  student_id uuid,
  provider_ref text,
  checkout_id text,
  created_at timestamptz not null default now()
);

create unique index payment_intents_ref_idx on public.payment_intents (provider, reference);

create table public.reconciliation_flags (
  id bigint generated always as identity primary key,
  reference text not null,
  kind text not null,
  local_cents integer,
  provider_cents integer,
  provider text,
  detail text not null default '',
  created_at timestamptz not null default now()
);

create table public.ratings (
  id bigint generated always as identity primary key,
  order_id text not null unique references public.orders (id),
  score integer not null check (score between 1 and 5),
  created_at timestamptz not null default now()
);

create table public.prep_forecasts (
  id bigint generated always as identity primary key,
  forecast_date date not null,
  item_id text not null,
  name text not null,
  history_avg numeric(12, 2) not null default 0,
  history_days integer not null default 0,
  preorders integer not null default 0,
  suggest_qty integer not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- JSON helpers used by the edge functions
-- ---------------------------------------------------------------------------

create or replace function public.order_json(p_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', o.id,
    'orderNumber', o.order_number,
    'status', o.status,
    'customerName', o.customer_name,
    'phone', o.phone,
    'pickupTime', o.pickup_time,
    'pickupLabel', o.pickup_label,
    'notes', o.notes,
    'itemCount', o.item_count,
    'totalCents', o.total_cents,
    'paymentMethod', o.payment_method,
    'paymentStatus', o.payment_status,
    'payOnCollection', o.pay_on_collection,
    'studentId', o.student_id,
    'loyaltyRedeemed', o.loyalty_redeemed,
    'discountCents', o.discount_cents,
    'reminderSentAt', o.reminder_sent_at,
    'noShowActionTakenAt', o.no_show_action_taken_at,
    'cancelReason', o.cancel_reason,
    'provider', o.provider,
    'demo', false,
    'source', o.source,
    'createdAt', o.created_at,
    'updatedAt', o.updated_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'itemId', i.item_id,
        'name', i.name,
        'qty', i.qty,
        'unitPriceCents', i.unit_price_cents,
        'lineTotalCents', i.line_total_cents,
        'loyaltyFreeQty', i.loyalty_free_qty
      ) order by i.id)
      from public.order_items i
      where i.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  where o.id = p_id;
$$;

create or replace function public.student_public(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', s.id,
    'studentNumber', s.student_number,
    'fullName', s.full_name,
    'phone', s.phone,
    'email', s.email,
    'balanceCents', s.balance_cents,
    'loyaltyStamps', s.loyalty_stamps,
    'nfcUid', coalesce(s.nfc_uid, ''),
    'autoTopup', s.auto_topup,
    'autoTopupCents', s.auto_topup_cents,
    'demo', false
  )
  from public.students s
  where s.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Mutations (service role only)
-- ---------------------------------------------------------------------------

create or replace function public.register_student(
  p_id uuid,
  p_number text,
  p_pin text,
  p_name text,
  p_phone text,
  p_email text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_number !~ '^[0-9]{4,12}$' then
    raise exception 'Enter your student number.';
  end if;
  if length(trim(p_pin)) < 4 then
    raise exception 'Choose a PIN of at least 4 digits.';
  end if;
  if length(trim(p_name)) < 2 then
    raise exception 'Please enter your name.';
  end if;
  insert into public.students (id, student_number, pin_hash, full_name, phone, email, auto_topup_cents)
  values (
    p_id,
    trim(p_number),
    crypt(trim(p_pin), gen_salt('bf')),
    trim(p_name),
    p_phone,
    lower(trim(coalesce(p_email, ''))),
    coalesce((select (data->>'autoTopupCents')::int from public.app_settings where id = 1), 10000)
  );
  return public.student_public(p_id);
end;
$$;

create or replace function public.student_by_pin(p_number text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  sid uuid;
begin
  select id into sid
  from public.students
  where student_number = trim(p_number)
    and pin_hash = crypt(trim(p_pin), pin_hash);
  if sid is null then
    return null;
  end if;
  return public.student_public(sid);
end;
$$;

create or replace function public.commit_sale(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text := p->>'id';
  v_pickup timestamptz := (p->>'pickupTime')::timestamptz;
  v_capacity integer;
  v_booked integer;
  v_item jsonb;
  v_menu public.menu_items%rowtype;
  v_total integer := coalesce((p->>'totalCents')::integer, 0);
  v_method text := p->>'paymentMethod';
  v_student uuid := nullif(p->>'studentId', '')::uuid;
  v_stamps integer := nullif(p->>'loyaltyStampsAfter', '')::integer;
  v_recipe record;
  v_qty numeric;
begin
  select coalesce((data->>'slotCapacity')::integer, 8) into v_capacity
  from public.app_settings where id = 1;

  select count(*) into v_booked
  from public.orders
  where pickup_time = v_pickup
    and status not in ('cancelled', 'no_show');

  if v_booked >= v_capacity then
    raise exception 'That pickup slot is full.';
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb))
  loop
    select * into v_menu from public.menu_items where id = v_item->>'itemId';
    if not found then
      raise exception 'An item in this order is not on the board.';
    end if;
    if v_menu.sold_out or (v_menu.portions is not null and v_menu.portions < (v_item->>'qty')::integer) then
      raise exception '% is sold out.', v_menu.name;
    end if;
  end loop;

  insert into public.orders (
    id, order_number, status, customer_name, phone, pickup_time, pickup_label, notes,
    item_count, total_cents, payment_method, payment_status, pay_on_collection,
    student_id, loyalty_redeemed, discount_cents, provider, source
  ) values (
    v_id,
    p->>'orderNumber',
    'received',
    p->>'customerName',
    p->>'phone',
    v_pickup,
    coalesce(p->>'pickupLabel', ''),
    coalesce(p->>'notes', ''),
    coalesce((p->>'itemCount')::integer, 0),
    v_total,
    v_method,
    coalesce(p->>'paymentStatus', 'unpaid'),
    coalesce((p->>'payOnCollection')::boolean, v_method = 'cash'),
    v_student,
    coalesce((p->>'loyaltyRedeemed')::boolean, false),
    coalesce((p->>'discountCents')::integer, 0),
    nullif(p->>'provider', ''),
    coalesce(nullif(p->>'source', ''), 'web')
  );

  for v_item in select value from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb))
  loop
    insert into public.order_items (order_id, item_id, name, qty, unit_price_cents, line_total_cents, loyalty_free_qty)
    values (
      v_id,
      v_item->>'itemId',
      v_item->>'name',
      (v_item->>'qty')::integer,
      (v_item->>'unitPriceCents')::integer,
      (v_item->>'lineTotalCents')::integer,
      coalesce((v_item->>'loyaltyFreeQty')::integer, 0)
    );

    for v_recipe in
      select r.ingredient_id, r.qty
      from public.recipes r
      where r.menu_item_id = v_item->>'itemId'
    loop
      v_qty := v_recipe.qty * (v_item->>'qty')::numeric;
      update public.ingredients
        set on_hand = on_hand - v_qty
        where id = v_recipe.ingredient_id;
      insert into public.stock_movements (ingredient_id, qty_delta, reason, ref, item_id)
      values (v_recipe.ingredient_id, -v_qty, 'sale', v_id, v_item->>'itemId');
    end loop;

    update public.menu_items
      set portions = greatest(0, portions - (v_item->>'qty')::integer),
          sold_out = (portions - (v_item->>'qty')::integer) <= 0
      where id = v_item->>'itemId'
        and portions is not null;
  end loop;

  if v_method = 'wallet' and v_total > 0 then
    if v_student is null then
      raise exception 'Sign in to your wallet to pay with credit.';
    end if;
    insert into public.wallet_ledger (student_id, amount_cents, balance_after_cents, kind, payment_method, order_id, note)
    values (v_student, -v_total, 0, 'order', 'wallet', v_id, coalesce(p->>'orderNumber', ''));
  end if;

  if v_student is not null and v_stamps is not null then
    update public.students set loyalty_stamps = greatest(0, v_stamps) where id = v_student;
  end if;

  return public.order_json(v_id);
end;
$$;

create or replace function public.set_order_status(p_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.orders%rowtype;
  flow text[] := array['received', 'preparing', 'ready', 'collected'];
  from_i integer;
  to_i integer;
begin
  select * into v from public.orders where id = p_id or order_number = p_id for update;
  if not found then
    return null;
  end if;
  if v.status = p_status then
    return public.order_json(v.id);
  end if;
  from_i := array_position(flow, v.status);
  to_i := array_position(flow, p_status);
  if from_i is null or to_i is null or to_i <> from_i + 1 then
    raise exception 'Status can only move Received → Preparing → Ready → Collected.';
  end if;
  update public.orders
    set status = p_status,
        payment_status = case
          when p_status = 'collected' and payment_method = 'cash' then 'paid'
          else payment_status
        end,
        updated_at = now()
    where id = v.id;
  return public.order_json(v.id);
end;
$$;

create or replace function public.cancel_order(p_id text, p_reason text, p_payment_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.orders%rowtype;
  line record;
  recipe record;
  v_qty numeric;
  stamps integer;
  goal integer;
  cost integer;
  next_status text;
begin
  select * into v from public.orders where id = p_id or order_number = p_id for update;
  if not found then
    return null;
  end if;
  if v.status in ('collected', 'cancelled', 'no_show') then
    raise exception 'This order can no longer be cancelled.';
  end if;

  goal := coalesce((select (data->>'loyaltyTarget')::integer from public.app_settings where id = 1), 10);

  if v.student_id is not null then
    select loyalty_stamps into stamps from public.students where id = v.student_id for update;
    if v.loyalty_redeemed then
      stamps := goal - 1;
    else
      stamps := greatest(0, coalesce(stamps, 0) - 1);
    end if;
    update public.students set loyalty_stamps = stamps where id = v.student_id;
  end if;

  next_status := p_payment_status;
  if v.payment_status = 'unpaid' and p_payment_status = 'refunded' then
    next_status := 'unpaid';
  end if;

  if p_payment_status = 'refunded'
     and v.payment_method = 'wallet'
     and v.payment_status = 'paid'
     and v.total_cents > 0
     and v.student_id is not null then
    insert into public.wallet_ledger (student_id, amount_cents, balance_after_cents, kind, payment_method, order_id, note)
    values (v.student_id, v.total_cents, 0, 'refund', 'wallet', v.id, 'Refund ' || v.order_number);
  end if;

  if p_payment_status = 'refunded' then
    for line in select * from public.order_items where order_id = v.id
    loop
      for recipe in
        select r.ingredient_id, r.qty from public.recipes r where r.menu_item_id = line.item_id
      loop
        v_qty := recipe.qty * line.qty;
        update public.ingredients set on_hand = on_hand + v_qty where id = recipe.ingredient_id;
        insert into public.stock_movements (ingredient_id, qty_delta, reason, ref, item_id)
        values (recipe.ingredient_id, v_qty, 'refund', v.id, line.item_id);
      end loop;
      update public.menu_items
        set portions = portions + line.qty,
            sold_out = false
        where id = line.item_id
          and portions is not null;
    end loop;
  end if;

  if p_payment_status = 'written_off' then
    for line in select * from public.order_items where order_id = v.id
    loop
      select coalesce(sum(round(i.cost_cents * r.qty)), 0)::integer into cost
      from public.recipes r
      join public.ingredients i on i.id = r.ingredient_id
      where r.menu_item_id = line.item_id;
      if cost > 0 then
        insert into public.waste_log (ingredient_id, name, qty, unit, cost_cents, reason)
        values ('', line.name, line.qty, 'plate', cost * line.qty, 'No-show write-off');
      end if;
    end loop;
  end if;

  update public.orders
    set status = 'cancelled',
        payment_status = next_status,
        cancel_reason = p_reason,
        no_show_action_taken_at = case when p_reason = 'no-show' then now() else no_show_action_taken_at end,
        updated_at = now()
    where id = v.id;

  return public.order_json(v.id);
end;
$$;

create or replace function public.wallet_credit(
  p_student uuid,
  p_amount integer,
  p_kind text,
  p_method text,
  p_order text,
  p_provider text,
  p_ref text,
  p_note text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_id uuid;
begin
  insert into public.wallet_ledger (
    student_id, amount_cents, balance_after_cents, kind, payment_method, order_id, provider, provider_ref, note
  ) values (
    p_student, p_amount, 0, p_kind, p_method, nullif(p_order, ''), nullif(p_provider, ''), nullif(p_ref, ''), coalesce(p_note, '')
  )
  returning id into row_id;

  return jsonb_build_object(
    'student', public.student_public(p_student),
    'entry', (
      select jsonb_build_object(
        'id', l.id,
        'studentId', l.student_id,
        'amountCents', l.amount_cents,
        'balanceAfterCents', l.balance_after_cents,
        'kind', l.kind,
        'paymentMethod', l.payment_method,
        'orderId', l.order_id,
        'provider', l.provider,
        'providerRef', l.provider_ref,
        'note', l.note,
        'createdAt', l.created_at,
        'demo', false
      )
      from public.wallet_ledger l where l.id = row_id
    )
  );
end;
$$;

create or replace function public.issue_pay_token(p_student uuid, p_token text, p_expires timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.pay_tokens
  where student_id = p_student
    and (consumed_at is not null or expires_at <= now() or token <> p_token);
  insert into public.pay_tokens (token, student_id, expires_at)
  values (p_token, p_student, p_expires)
  on conflict (token) do nothing;
  return jsonb_build_object(
    'token', p_token,
    'studentId', p_student,
    'expiresAt', p_expires,
    'consumedAt', null,
    'payload', 'FC1.' || p_token,
    'createdAt', now(),
    'demo', false
  );
end;
$$;

create or replace function public.consume_pay_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
begin
  update public.pay_tokens
    set consumed_at = now()
    where token = upper(trim(p_token))
      and consumed_at is null
      and expires_at > now()
    returning student_id into sid;
  return sid;
end;
$$;

create or replace function public.link_nfc(p_student uuid, p_uid text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if length(trim(p_uid)) < 4 then
    raise exception 'Tap the card again so we can read it.';
  end if;
  if exists (select 1 from public.students where nfc_uid = trim(p_uid) and id <> p_student) then
    raise exception 'That card is already linked to another wallet.';
  end if;
  update public.students set nfc_uid = trim(p_uid) where id = p_student;
  return public.student_public(p_student);
end;
$$;

create or replace function public.set_auto_topup(p_student uuid, p_enabled boolean, p_amount integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.students
    set auto_topup = p_enabled,
        auto_topup_cents = case when p_amount is null then auto_topup_cents else p_amount end
    where id = p_student;
  return public.student_public(p_student);
end;
$$;

create or replace function public.publish_special(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text := p->>'id';
  v_date date := (p->>'specialDate')::date;
begin
  update public.daily_specials set status = 'removed' where special_date = v_date and status = 'live';
  insert into public.daily_specials (
    id, special_date, name, price_cents, dow, day_label, caption, image_url, source, status, item_id
  ) values (
    v_id,
    v_date,
    p->>'name',
    (p->>'priceCents')::integer,
    nullif(p->>'dow', '')::integer,
    coalesce(p->>'dayLabel', ''),
    coalesce(p->>'caption', ''),
    coalesce(p->>'imageUrl', ''),
    coalesce(p->>'source', 'chef-page'),
    'live',
    nullif(p->>'itemId', '')
  );
  return jsonb_build_object(
    'id', v_id,
    'specialDate', v_date,
    'name', p->>'name',
    'priceCents', (p->>'priceCents')::integer,
    'dow', nullif(p->>'dow', '')::integer,
    'dayLabel', coalesce(p->>'dayLabel', ''),
    'caption', coalesce(p->>'caption', ''),
    'imageUrl', coalesce(p->>'imageUrl', ''),
    'source', coalesce(p->>'source', 'chef-page'),
    'status', 'live',
    'itemId', nullif(p->>'itemId', ''),
    'demo', false,
    'createdAt', now()
  );
end;
$$;

create or replace function public.stock_receive(p_id text, p_qty numeric, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ing public.ingredients%rowtype;
  cost integer;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'Enter a quantity received.';
  end if;
  select * into ing from public.ingredients where id = p_id for update;
  if not found then
    raise exception 'Unknown stock item.';
  end if;
  update public.ingredients set on_hand = on_hand + p_qty where id = p_id;
  cost := round(ing.cost_cents * p_qty);
  insert into public.stock_movements (ingredient_id, qty_delta, reason, note)
  values (p_id, p_qty, 'receive', coalesce(p_note, ''));
  insert into public.goods_received (ingredient_id, name, qty, cost_cents, note)
  values (p_id, ing.name, p_qty, cost, coalesce(p_note, ''));
  return jsonb_build_object(
    'ingredientId', p_id,
    'qty', p_qty,
    'costCents', cost,
    'note', coalesce(p_note, ''),
    'name', ing.name
  );
end;
$$;

create or replace function public.stock_waste(p_id text, p_qty numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ing public.ingredients%rowtype;
  cost integer;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'Enter a waste quantity.';
  end if;
  select * into ing from public.ingredients where id = p_id for update;
  if not found then
    raise exception 'Unknown stock item.';
  end if;
  update public.ingredients set on_hand = on_hand - p_qty where id = p_id;
  cost := round(ing.cost_cents * p_qty);
  insert into public.stock_movements (ingredient_id, qty_delta, reason, note)
  values (p_id, -p_qty, 'waste', coalesce(p_reason, ''));
  insert into public.waste_log (ingredient_id, name, qty, unit, cost_cents, reason)
  values (p_id, ing.name, p_qty, ing.unit, cost, coalesce(p_reason, ''));
  return jsonb_build_object(
    'ingredientId', p_id,
    'name', ing.name,
    'qty', p_qty,
    'unit', ing.unit,
    'costCents', cost,
    'reason', coalesce(p_reason, '')
  );
end;
$$;

create or replace function public.stock_take(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  line jsonb;
  ing public.ingredients%rowtype;
  counted numeric;
  variance numeric;
  variances jsonb := '[]'::jsonb;
begin
  for line in select value from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb))
  loop
    select * into ing from public.ingredients where id = line->>'ingredientId' for update;
    if not found then
      continue;
    end if;
    counted := (line->>'countedQty')::numeric;
    if counted is null or counted < 0 then
      raise exception 'Count for % is not valid.', ing.name;
    end if;
    variance := round((counted - ing.on_hand) * 1000) / 1000;
    update public.ingredients set on_hand = counted where id = ing.id;
    if variance <> 0 then
      insert into public.stock_movements (ingredient_id, qty_delta, reason)
      values (ing.id, variance, 'stock-take');
    end if;
    variances := variances || jsonb_build_array(jsonb_build_object(
      'ingredientId', ing.id,
      'name', ing.name,
      'unit', ing.unit,
      'expectedQty', ing.on_hand,
      'countedQty', counted,
      'variance', variance
    ));
  end loop;
  insert into public.stock_takes (note, lines)
  values (coalesce(p->>'note', ''), variances);
  return variances;
end;
$$;

create or replace function public.save_settings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.app_settings set data = p where id = 1;
  return p;
end;
$$;

create or replace function public.mark_reminder(p_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.orders set reminder_sent_at = now(), updated_at = now() where id = p_id;
$$;

create or replace function public.mark_low_balance(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.students set low_balance_alerted_at = now() where id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Report views (same orders and ledger the kitchen page reads)
-- ---------------------------------------------------------------------------

create or replace view public.v_revenue_orders
with (security_invoker = false) as
select
  o.*,
  (o.created_at at time zone 'Africa/Johannesburg')::date as sale_date,
  extract(dow from o.created_at at time zone 'Africa/Johannesburg')::integer as sale_dow,
  extract(hour from o.created_at at time zone 'Africa/Johannesburg')::integer as sale_hour
from public.orders o
where o.status not in ('cancelled', 'no_show')
  and o.payment_status not in ('refunded', 'written_off')
  and (
    (o.payment_method = 'cash' and (o.status = 'collected' or o.payment_status = 'paid'))
    or (o.payment_method <> 'cash' and o.payment_status = 'paid')
  );

create or replace view public.v_revenue_by_method
with (security_invoker = false) as
select payment_method, count(*)::integer as orders, coalesce(sum(total_cents), 0)::bigint as revenue_cents
from public.v_revenue_orders
group by payment_method;

create or replace view public.v_item_units
with (security_invoker = false) as
select
  i.item_id,
  i.name,
  sum(i.qty)::bigint as qty,
  sum(i.line_total_cents)::bigint as revenue_cents
from public.order_items i
join public.v_revenue_orders o on o.id = i.order_id
group by i.item_id, i.name;

create or replace view public.v_sales_by_dow
with (security_invoker = false) as
select sale_dow as dow, count(*)::integer as orders, coalesce(sum(total_cents), 0)::bigint as revenue_cents
from public.v_revenue_orders
group by sale_dow;

create or replace view public.v_sales_by_hour
with (security_invoker = false) as
select sale_hour as hour, count(*)::integer as orders, coalesce(sum(total_cents), 0)::bigint as revenue_cents
from public.v_revenue_orders
group by sale_hour;

create or replace view public.v_wallet_liability
with (security_invoker = false) as
select coalesce(sum(balance_cents), 0)::bigint as outstanding_liability_cents
from public.students;

create or replace view public.v_special_performance
with (security_invoker = false) as
select
  s.special_date,
  s.name,
  s.price_cents,
  coalesce(sum(i.qty), 0)::bigint as qty,
  coalesce(sum(i.line_total_cents), 0)::bigint as revenue_cents
from public.daily_specials s
left join public.v_revenue_orders o
  on o.sale_date = s.special_date
left join public.order_items i
  on i.order_id = o.id
 and (lower(i.name) = lower(s.name) or i.item_id = s.item_id)
where s.status = 'live'
group by s.special_date, s.name, s.price_cents;

create or replace view public.v_refunds
with (security_invoker = false) as
select
  count(*) filter (where payment_status = 'refunded')::integer as refund_count,
  coalesce(sum(total_cents) filter (where payment_status = 'refunded'), 0)::bigint as refund_cents,
  count(*) filter (where payment_status = 'written_off')::integer as writeoff_count,
  coalesce(sum(total_cents) filter (where payment_status = 'written_off'), 0)::bigint as writeoff_cents
from public.orders;

create or replace view public.counter_now
with (security_invoker = false) as
select id, order_number, customer_name, pickup_label, status
from public.orders
where status = 'ready';

comment on view public.v_revenue_orders is
  'Recognised sales: wallet and card when paid; cash when collected or marked paid. Cancelled, no-show, refunded, and written-off orders are excluded.';

create or replace function public.kitchen_finance_report(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with recognised as (
    select * from public.v_revenue_orders
    where sale_date between p_from and p_to
  ),
  methods as (
    select payment_method, count(*)::int as orders, coalesce(sum(total_cents), 0)::int as revenue_cents
    from recognised group by payment_method
  )
  select jsonb_build_object(
    'demo', false,
    'from', p_from,
    'to', p_to,
    'currency', 'ZAR',
    'revenueCents', coalesce((select sum(total_cents) from recognised), 0),
    'orderCount', (select count(*) from recognised),
    'byMethod', jsonb_build_object(
      'wallet', jsonb_build_object(
        'orders', coalesce((select orders from methods where payment_method = 'wallet'), 0),
        'revenueCents', coalesce((select revenue_cents from methods where payment_method = 'wallet'), 0)
      ),
      'card', jsonb_build_object(
        'orders', coalesce((select orders from methods where payment_method = 'card'), 0),
        'revenueCents', coalesce((select revenue_cents from methods where payment_method = 'card'), 0)
      ),
      'cash', jsonb_build_object(
        'orders', coalesce((select orders from methods where payment_method = 'cash'), 0),
        'revenueCents', coalesce((select revenue_cents from methods where payment_method = 'cash'), 0)
      )
    ),
    'wallet', jsonb_build_object(
      'outstandingLiabilityCents', (select outstanding_liability_cents from public.v_wallet_liability)
    ),
    'stockValueCents', (
      select coalesce(sum(round(greatest(on_hand, 0) * cost_cents)), 0)
      from public.ingredients
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.menu_items enable row level security;
alter table public.students enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.pay_tokens enable row level security;
alter table public.email_codes enable row level security;
alter table public.daily_specials enable row level security;
alter table public.app_settings enable row level security;
alter table public.suppliers enable row level security;
alter table public.ingredients enable row level security;
alter table public.recipes enable row level security;
alter table public.stock_movements enable row level security;
alter table public.goods_received enable row level security;
alter table public.waste_log enable row level security;
alter table public.stock_takes enable row level security;
alter table public.automation_runs enable row level security;
alter table public.notifications enable row level security;
alter table public.payment_intents enable row level security;
alter table public.reconciliation_flags enable row level security;
alter table public.ratings enable row level security;
alter table public.prep_forecasts enable row level security;

create policy menu_read on public.menu_items for select to anon, authenticated using (true);
create policy specials_read on public.daily_specials for select to anon, authenticated using (status = 'live');
create policy students_self on public.students for select to authenticated using (id = auth.uid());
create policy orders_self on public.orders for select to authenticated using (student_id = auth.uid());
create policy items_self on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.student_id = auth.uid()));
create policy ledger_self on public.wallet_ledger for select to authenticated using (student_id = auth.uid());
create policy ratings_self on public.ratings for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.student_id = auth.uid()));

grant select on public.counter_now to anon, authenticated;

revoke all on public.v_revenue_orders from public, anon, authenticated;
revoke all on public.v_revenue_by_method from public, anon, authenticated;
revoke all on public.v_item_units from public, anon, authenticated;
revoke all on public.v_sales_by_dow from public, anon, authenticated;
revoke all on public.v_sales_by_hour from public, anon, authenticated;
revoke all on public.v_wallet_liability from public, anon, authenticated;
revoke all on public.v_special_performance from public, anon, authenticated;
revoke all on public.v_refunds from public, anon, authenticated;

grant select on public.v_revenue_orders, public.v_revenue_by_method, public.v_item_units,
  public.v_sales_by_dow, public.v_sales_by_hour, public.v_wallet_liability,
  public.v_special_performance, public.v_refunds
  to service_role;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'wallet_ledger_apply()',
    'order_json(text)',
    'student_public(uuid)',
    'register_student(uuid, text, text, text, text, text)',
    'student_by_pin(text, text)',
    'commit_sale(jsonb)',
    'set_order_status(text, text)',
    'cancel_order(text, text, text)',
    'wallet_credit(uuid, integer, text, text, text, text, text, text)',
    'issue_pay_token(uuid, text, timestamp with time zone)',
    'consume_pay_token(text)',
    'link_nfc(uuid, text)',
    'set_auto_topup(uuid, boolean, integer)',
    'publish_special(jsonb)',
    'stock_receive(text, numeric, text)',
    'stock_waste(text, numeric, text)',
    'stock_take(jsonb)',
    'save_settings(jsonb)',
    'mark_reminder(text)',
    'mark_low_balance(uuid)',
    'kitchen_finance_report(date, date)'
  ]
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Seed: real menu and starter stock. No fake live orders.
-- ---------------------------------------------------------------------------

insert into public.app_settings (id, data) values (
  1,
  '{
    "lowBalanceCents": 5000,
    "autoTopupCents": 10000,
    "noShowReminderMinutes": 30,
    "noShowActionMinutes": 90,
    "noShowAction": "refund",
    "slotCapacity": 8,
    "loyaltyTarget": 10,
    "ratingAlertMax": 2,
    "portionLowThreshold": 5,
    "chefNudgeHour": 7,
    "specialDeadlineHour": 9,
    "eodHour": 17,
    "forecastHour": 6,
    "managerWhatsapp": "",
    "kitchenWhatsapp": "",
    "chefWhatsappAllowlist": "",
    "managerEmail": "",
    "reportsEmail": ""
  }'::jsonb
);

insert into public.menu_items
  (id, category, name, description, price_cents, image, popular, available_days, special_on, badge, sort)
values
  ('eggs-toast', 'breakfast', 'Eggs on toast', 'Fried eggs on toast, campus breakfast.', 3800, '/assets/food/eggs.jpg', true, '{}', '{}', '', 10),
  ('breakfast-roll', 'breakfast', 'Breakfast roll', 'Filled roll to grab between lectures.', 4500, '/assets/food/breakfast-roll.jpg', false, '{}', '{}', '', 20),
  ('full-brunch', 'breakfast', 'Full brunch', 'Eggs, wors and chips. Saturday kitchen.', 8900, '/assets/food/brunch.jpg', false, '{6}', '{6}', 'Sat only', 30),
  ('beef-stew', 'lunch', 'Beef stew & pap', 'Slow pot, served with pap.', 7200, '/assets/food/beef-stew.jpg', true, '{}', '{1,4}', '', 40),
  ('chicken-stew', 'lunch', 'Chicken stew', 'Daily pot — pap or rice on the side.', 7000, '/assets/food/chicken-stew.jpg', false, '{}', '{}', '', 50),
  ('mogodu', 'lunch', 'Mogodu & pap', 'Tripe, dumpling or pap, chilli oil.', 8000, '/assets/food/spicy.jpg', false, '{}', '{2}', '', 60),
  ('veg-curry', 'lunch', 'Veg curry & rice', 'Vegetarian pot of the day with rice.', 6000, '/assets/food/veg-curry.jpg', false, '{}', '{}', '', 70),
  ('chicken-2pc', 'grill', 'Fried chicken 2pc', 'Crisp pieces. Add chips or pap.', 5500, '/assets/food/chicken-2pc.jpg', false, '{}', '{}', '', 80),
  ('chicken-3pc', 'grill', 'Fried chicken 3pc', 'Wednesday favourite — pap or chips.', 6800, '/assets/food/chicken.jpg', true, '{}', '{3}', '', 90),
  ('campus-burger', 'grill', 'Campus burger & chips', 'Sesame bun, cheese, chips in the box.', 6900, '/assets/food/burger.jpg', true, '{}', '{}', '', 100),
  ('pap-wors', 'grill', 'Pap & wors', 'Grill plate. Friday shisa nyama energy.', 6500, '/assets/food/grill.jpg', false, '{}', '{5}', '', 110),
  ('pap-gravy', 'sides', 'Pap & gravy', 'Soft pap with gravy from the pot.', 3500, '/assets/food/spicy.jpg', false, '{}', '{}', '', 120),
  ('chakalaka', 'sides', 'Chakalaka beans', 'Slow pot. Dumpling or pap on request.', 2800, '/assets/food/veg-curry.jpg', false, '{}', '{}', '', 130),
  ('chips', 'sides', 'Chips', 'Hot portion, salted.', 3000, '/assets/food/chips.jpg', false, '{}', '{}', '', 140),
  ('salad-box', 'sides', 'Salad box', 'Fresh box when you want something light.', 4200, '/assets/food/salad.jpg', false, '{}', '{}', '', 150),
  ('coffee-tea', 'drinks', 'Coffee / tea', 'Hot cup from the counter.', 2200, '/assets/food/coffee.jpg', false, '{}', '{}', '', 160),
  ('juice', 'drinks', 'Juice', 'Cold juice, fridge stock.', 2000, '/assets/food/juice.jpg', false, '{}', '{}', '', 170),
  ('milkshake', 'drinks', 'Milkshake', 'Thick shake when the blender is on.', 3200, '/assets/food/milkshake.jpg', false, '{}', '{}', '', 180);

insert into public.suppliers (id, name, phone, email) values
  ('sup_metro', 'Metro Foods', '011 555 0101', 'orders@metrofoods.example'),
  ('sup_fresh', 'Fresh Campus', '011 555 0144', 'hello@freshcampus.example');

insert into public.ingredients (id, name, unit, cost_cents, on_hand, reorder_level, supplier_id) values
  ('ing_beef', 'Beef stew portion', 'portion', 2800, 40, 12, 'sup_metro'),
  ('ing_chicken', 'Chicken pieces', 'piece', 1800, 36, 24, 'sup_metro'),
  ('ing_chips', 'Chips', 'portion', 800, 30, 15, 'sup_fresh'),
  ('ing_bun', 'Burger bun', 'each', 400, 24, 16, 'sup_fresh'),
  ('ing_pap', 'Pap', 'portion', 300, 50, 10, 'sup_metro'),
  ('ing_juice', 'Juice', 'carton', 900, 18, 12, 'sup_fresh'),
  ('ing_coffee', 'Coffee', 'cup', 400, 40, 10, 'sup_metro'),
  ('ing_salad', 'Salad mix', 'box', 1500, 8, 6, 'sup_fresh');

insert into public.recipes (menu_item_id, ingredient_id, qty) values
  ('campus-burger', 'ing_bun', 1),
  ('campus-burger', 'ing_chips', 1),
  ('chips', 'ing_chips', 1),
  ('beef-stew', 'ing_beef', 1),
  ('beef-stew', 'ing_pap', 1),
  ('juice', 'ing_juice', 1),
  ('coffee-tea', 'ing_coffee', 1),
  ('chicken-2pc', 'ing_chicken', 2),
  ('salad-box', 'ing_salad', 1);

insert into storage.buckets (id, name, public)
values ('specials', 'specials', true)
on conflict (id) do update set public = true;

drop policy if exists specials_public_read on storage.objects;
create policy specials_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'specials');

-- ---------------------------------------------------------------------------
-- Schedules. SAST is UTC+2. Empty runtime_config skips the HTTP call.
-- ---------------------------------------------------------------------------

create or replace function private.invoke_automation(job text)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
  base text;
  secret text;
begin
  select value into base from private.runtime_config where key = 'functions_base_url';
  select value into secret from private.runtime_config where key = 'cron_secret';
  if coalesce(base, '') = '' or coalesce(secret, '') = '' then
    insert into public.automation_runs (job, status, detail)
    values (job, 'skipped', 'runtime_config functions_base_url or cron_secret is empty');
    return;
  end if;
  perform net.http_post(
    url := rtrim(base, '/') || '/automations',
    body := jsonb_build_object('job', job),
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', secret
    ),
    timeout_milliseconds := 5000
  );
end;
$$;

revoke all on function private.invoke_automation(text) from public, anon, authenticated;

do $$
declare
  r record;
begin
  if to_regnamespace('cron') is null or to_regnamespace('net') is null then
    raise notice 'pg_cron or pg_net is not enabled. Enable both in Database → Extensions and run this migration again so the Food Court jobs are scheduled.';
    return;
  end if;
  for r in select jobid from cron.job where jobname like 'foodcourt-%'
  loop
    perform cron.unschedule(r.jobid);
  end loop;
  perform cron.schedule('foodcourt-low-balance', '*/15 * * * *', $job$select private.invoke_automation('low-balance')$job$);
  perform cron.schedule('foodcourt-no-show', '*/10 * * * *', $job$select private.invoke_automation('no-show')$job$);
  perform cron.schedule('foodcourt-chef-nudge', '0 5 * * *', $job$select private.invoke_automation('chef-nudge')$job$);
  perform cron.schedule('foodcourt-special-deadline', '0 7 * * *', $job$select private.invoke_automation('special-deadline')$job$);
  perform cron.schedule('foodcourt-stock', '*/30 * * * *', $job$select private.invoke_automation('stock')$job$);
  perform cron.schedule('foodcourt-eod', '45 15 * * *', $job$select private.invoke_automation('eod')$job$);
  perform cron.schedule('foodcourt-weekly-csv', '30 5 * * 1', $job$select private.invoke_automation('weekly-csv')$job$);
  perform cron.schedule('foodcourt-forecast', '0 4 * * 1-6', $job$select private.invoke_automation('forecast')$job$);
  perform cron.schedule('foodcourt-reconcile', '30 20 * * *', $job$select private.invoke_automation('reconcile')$job$);
end $$;
