create or replace function public.sawakai_location_check_membership()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  groups jsonb;
  members jsonb;
  member_key text;
begin
  if new.latitude is null then return new; end if;
  select value into groups from public.kv_store_8e9e0c0c
    where key = 'sawakai:groups' for share;
  member_key := case when new.group_id = 'weekend-meal' then 'sawakai:members'
    else 'sawakai:group:' || new.group_id || ':members' end;
  select value into members from public.kv_store_8e9e0c0c
    where key = member_key for share;
  if not exists (select 1 from jsonb_array_elements(coalesce(groups, '[]'::jsonb)) g
                 where g->>'id' = new.group_id)
     or not exists (select 1 from jsonb_array_elements(coalesce(members, '[]'::jsonb)) m
                    where m->>'name' = new.member_name) then
    raise exception 'Location share member is not in group';
  end if;
  return new;
end;
$$;

create trigger sawakai_location_check_membership
before insert or update on public.sawakai_location_shares
for each row execute function public.sawakai_location_check_membership();

create or replace function public.sawakai_location_remove_departed()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  record_key text := coalesce(new.key, old.key);
  group_id text;
  value_json jsonb := case when tg_op = 'DELETE' then '[]'::jsonb else new.value end;
begin
  if record_key = 'sawakai:groups' then
    delete from public.sawakai_location_shares s
      where not exists (select 1 from jsonb_array_elements(value_json) g where g->>'id' = s.group_id);
  elsif record_key = 'sawakai:members' or
        (record_key like 'sawakai:group:%:members') then
    group_id := case when record_key = 'sawakai:members' then 'weekend-meal'
      else substr(record_key, length('sawakai:group:') + 1,
        length(record_key) - length('sawakai:group:') - length(':members')) end;
    delete from public.sawakai_location_shares s
      where s.group_id = group_id
        and not exists (select 1 from jsonb_array_elements(value_json) m where m->>'name' = s.member_name);
  end if;
  return coalesce(new, old);
end;
$$;

create trigger sawakai_location_remove_departed
after update or delete on public.kv_store_8e9e0c0c
for each row execute function public.sawakai_location_remove_departed();
