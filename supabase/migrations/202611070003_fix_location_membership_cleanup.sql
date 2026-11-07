create or replace function public.sawakai_location_remove_departed()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  record_key text := coalesce(new.key, old.key);
  affected_group_id text;
  value_json jsonb := case when tg_op = 'DELETE' then '[]'::jsonb else new.value end;
begin
  if record_key = 'sawakai:groups' then
    delete from public.sawakai_location_shares s
      where not exists (select 1 from jsonb_array_elements(value_json) g where g->>'id' = s.group_id);
  elsif record_key = 'sawakai:members' or
        (record_key like 'sawakai:group:%:members') then
    affected_group_id := case when record_key = 'sawakai:members' then 'weekend-meal'
      else substr(record_key, length('sawakai:group:') + 1,
        length(record_key) - length('sawakai:group:') - length(':members')) end;
    delete from public.sawakai_location_shares s
      where s.group_id = affected_group_id
        and not exists (select 1 from jsonb_array_elements(value_json) m where m->>'name' = s.member_name);
  end if;
  return coalesce(new, old);
end;
$$;
