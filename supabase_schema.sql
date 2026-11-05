-- =============================================================================
-- Schéma Base de Données Supabase : Application Interactive de Présentation & Sondage
-- =============================================================================

-- Extension pour la génération d'UUID
create extension if not exists "pgcrypto";

-- 1. Table `sessions`
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  title text not null,
  current_slide integer not null default 1,
  active_question_id uuid null,
  show_results boolean not null default false,
  reveal_answer boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2. Table `questions`
create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  title text not null,
  type text not null default 'mcq' check (type in ('mcq', 'tf', 'scale', 'open')),
  options jsonb not null default '[]'::jsonb,
  correct_option text null,
  slide_number integer null,
  is_open boolean not null default false,
  order_index integer not null default 0,
  created_at timestamptz not null default now()
);

-- Ajout de la contrainte FK optionnelle entre sessions.active_question_id et questions.id
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sessions_active_question_id_fkey'
  ) then
    alter table public.sessions
      add constraint sessions_active_question_id_fkey
      foreign key (active_question_id) references public.questions(id) on delete set null;
  end if;
end $$;

-- 3. Table `participants`
create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  nickname text not null,
  created_at timestamptz not null default now()
);

-- 4. Table `votes`
create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  answer text not null,
  created_at timestamptz not null default now(),
  constraint votes_question_participant_unique unique (question_id, participant_id)
);

-- Index pour optimiser les performances en temps réel
create index if not exists idx_sessions_code on public.sessions(code);
create index if not exists idx_questions_session_id on public.questions(session_id);
create index if not exists idx_participants_session_id on public.participants(session_id);
create index if not exists idx_votes_session_id on public.votes(session_id);
create index if not exists idx_votes_question_id on public.votes(question_id);

-- Configuration Row Level Security (RLS) ouverte pour usage salle de classe avec clé anon
alter table public.sessions enable row level security;
alter table public.questions enable row level security;
alter table public.participants enable row level security;
alter table public.votes enable row level security;

drop policy if exists "Accès public sessions" on public.sessions;
create policy "Accès public sessions" on public.sessions for all using (true) with check (true);

drop policy if exists "Accès public questions" on public.questions;
create policy "Accès public questions" on public.questions for all using (true) with check (true);

drop policy if exists "Accès public participants" on public.participants;
create policy "Accès public participants" on public.participants for all using (true) with check (true);

drop policy if exists "Accès public votes" on public.votes;
create policy "Accès public votes" on public.votes for all using (true) with check (true);

-- Réplication complète pour recevoir toutes les colonnes dans les événements Realtime
alter table public.sessions replica identity full;
alter table public.questions replica identity full;
alter table public.participants replica identity full;
alter table public.votes replica identity full;

-- Activation de Supabase Realtime sur les 4 tables (idempotent)
do $$
begin
  begin alter publication supabase_realtime add table public.sessions; exception when others then null; end;
  begin alter publication supabase_realtime add table public.questions; exception when others then null; end;
  begin alter publication supabase_realtime add table public.participants; exception when others then null; end;
  begin alter publication supabase_realtime add table public.votes; exception when others then null; end;
end $$;

-- Initialisation automatique de la session PowerPoint 38NKMQ
insert into public.sessions (id, code, title, current_slide, active_question_id, show_results, reveal_answer, is_active)
values (
  '7cd937da-c15d-44d0-8329-e77be4d47a84',
  '38NKMQ',
  'Séance de Vote PowerPoint — Collège des MN',
  1,
  null,
  false,
  false,
  true
)
on conflict (code) do nothing;
