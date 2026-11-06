import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type {
  Session,
  Question,
  Participant,
  Vote,
  CreateQuestionInput,
  UpdateQuestionInput,
  SessionRealtimeCallbacks,
} from '../types/poll';

// ============================================================================
// Stockage Réseau Local Partagé (/api/db sur le serveur Vite) + Fallback LocalStorage
// Permet au PC et aux smartphones en Wi-Fi (192.168.x.x:5173) de partager
// la même séance et les mêmes votes en temps réel sans configuration externe.
// ============================================================================
const LOCAL_STORAGE_KEY = 'pulseslide_local_db_v1';
const BROADCAST_CHANNEL_NAME = 'pulseslide_realtime_sync';

interface LocalDatabase {
  sessions: Session[];
  questions: Question[];
  participants: Participant[];
  votes: Vote[];
}

function readBrowserCacheDb(): LocalDatabase {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) {
      return { sessions: [], questions: [], participants: [], votes: [] };
    }
    return JSON.parse(raw) as LocalDatabase;
  } catch {
    return { sessions: [], questions: [], participants: [], votes: [] };
  }
}

async function readLocalDb(): Promise<LocalDatabase> {
  try {
    const res = await fetch('/api/db', { cache: 'no-store' });
    if (res.ok) {
      const serverDb = (await res.json()) as LocalDatabase;
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(serverDb));
      return serverDb;
    }
  } catch {
    // Fallback sur le cache navigateur si hors-ligne
  }
  return readBrowserCacheDb();
}

async function writeLocalDb(db: LocalDatabase, sessionId?: string): Promise<void> {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(db));
  try {
    await fetch('/api/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'WRITE_DB', db }),
    });
  } catch {
    // Ignorer si le serveur local n'est pas joignable
  }
  if (typeof BroadcastChannel !== 'undefined') {
    const bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    bc.postMessage({ type: 'DB_UPDATED', sessionId });
    bc.close();
  }
  window.dispatchEvent(new CustomEvent('pulseslide-local-update', { detail: { sessionId } }));
}

// Synchronisation immédiate au chargement du module côté navigateur
if (typeof window !== 'undefined' && !isSupabaseConfigured) {
  void readLocalDb();
}

/**
 * Génère un identifiant UUID compatible avec les connexions Wi-Fi HTTP (http://192.168.x.x)
 * où `crypto.randomUUID` n'est pas exposé par les navigateurs mobiles hors HTTPS.
 */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function normalizeOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item));
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeQuestion(row: Record<string, unknown>): Question {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    title: String(row.title ?? ''),
    type: (row.type as Question['type']) || 'mcq',
    options: normalizeOptions(row.options),
    correct_option: row.correct_option ? String(row.correct_option) : null,
    slide_number:
      row.slide_number !== null && row.slide_number !== undefined
        ? Number(row.slide_number)
        : null,
    is_open: Boolean(row.is_open),
    order_index: Number(row.order_index ?? 0),
    created_at: String(row.created_at ?? new Date().toISOString()),
  };
}

// ============================================================================
// Génération d'un code de session unique à 6 caractères (ex: "AB12CD")
// ============================================================================
export function generateSessionCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ============================================================================
// Service CRUD & Temps Réel Supabase
// ============================================================================
export const pollService = {
  // --------------------------------------------------------------------------
  // SESSIONS
  // --------------------------------------------------------------------------
  async createSession(title: string): Promise<Session> {
    const cleanTitle = title.trim() || 'Session Interactive';
    const code = generateSessionCode();

    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      const newSession: Session = {
        id: generateUUID(),
        code,
        title: cleanTitle,
        current_slide: 1,
        active_question_id: null,
        show_results: false,
        reveal_answer: false,
        is_active: true,
        created_at: new Date().toISOString(),
      };
      db.sessions.unshift(newSession);
      await writeLocalDb(db, newSession.id);
      return newSession;
    }

    const { data, error } = await supabase
      .from('sessions')
      .insert({
        code,
        title: cleanTitle,
        current_slide: 1,
        active_question_id: null,
        show_results: false,
        reveal_answer: false,
        is_active: true,
      })
      .select('*')
      .single();

    if (error) throw new Error(`Erreur création session : ${error.message}`);
    return data as Session;
  },

  async getSessionByCode(code: string): Promise<Session | null> {
    const normalizedCode = code.trim().toUpperCase();
    if (!normalizedCode) return null;

    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      return (
        db.sessions.find((s) => s.code.toUpperCase() === normalizedCode) ??
        db.sessions[0] ??
        null
      );
    }

    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('code', normalizedCode)
      .maybeSingle();

    if (error) throw new Error(`Erreur recherche session : ${error.message}`);
    return (data as Session) ?? null;
  },

  async getSessionById(sessionId: string): Promise<Session | null> {
    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      return db.sessions.find((s) => s.id === sessionId) ?? null;
    }

    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .maybeSingle();

    if (error) throw new Error(`Erreur chargement session : ${error.message}`);
    return (data as Session) ?? null;
  },

  async listRecentSessions(limit = 10): Promise<Session[]> {
    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      return db.sessions.slice(0, limit);
    }

    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw new Error(`Erreur liste des sessions : ${error.message}`);
    return (data as Session[]) ?? [];
  },

  async updateSessionState(
    sessionId: string,
    patch: Partial<
      Pick<
        Session,
        | 'title'
        | 'current_slide'
        | 'active_question_id'
        | 'show_results'
        | 'reveal_answer'
        | 'is_active'
      >
    >
  ): Promise<Session> {
    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      const idx = db.sessions.findIndex((s) => s.id === sessionId);
      if (idx === -1) throw new Error('Session introuvable');
      db.sessions[idx] = { ...db.sessions[idx], ...patch };
      await writeLocalDb(db, sessionId);
      return db.sessions[idx];
    }

    const { data, error } = await supabase
      .from('sessions')
      .update(patch)
      .eq('id', sessionId)
      .select('*')
      .single();

    if (error) throw new Error(`Erreur mise à jour session : ${error.message}`);
    return data as Session;
  },

  // --------------------------------------------------------------------------
  // QUESTIONS
  // --------------------------------------------------------------------------
  async getQuestionsBySession(sessionId: string): Promise<Question[]> {
    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      return db.questions
        .filter((q) => q.session_id === sessionId)
        .sort((a, b) => a.order_index - b.order_index || a.created_at.localeCompare(b.created_at));
    }

    const { data, error } = await supabase
      .from('questions')
      .select('*')
      .eq('session_id', sessionId)
      .order('order_index', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) throw new Error(`Erreur chargement questions : ${error.message}`);
    return (data ?? []).map((row) => normalizeQuestion(row as Record<string, unknown>));
  },

  async getQuestionById(questionId: string): Promise<Question | null> {
    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      return db.questions.find((q) => q.id === questionId) ?? null;
    }

    const { data, error } = await supabase
      .from('questions')
      .select('*')
      .eq('id', questionId)
      .maybeSingle();

    if (error) throw new Error(`Erreur chargement question : ${error.message}`);
    return data ? normalizeQuestion(data as Record<string, unknown>) : null;
  },

  async createQuestion(input: CreateQuestionInput): Promise<Question> {
    const payload = {
      session_id: input.session_id,
      title: input.title.trim(),
      type: input.type,
      options: input.options,
      correct_option: input.correct_option?.trim() || null,
      slide_number:
        input.slide_number !== null && input.slide_number !== undefined && input.slide_number > 0
          ? Number(input.slide_number)
          : null,
      is_open: input.is_open ?? false,
      order_index: input.order_index ?? 0,
    };

    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      const created: Question = {
        id: generateUUID(),
        ...payload,
        created_at: new Date().toISOString(),
      };
      db.questions.push(created);
      await writeLocalDb(db, input.session_id);
      return created;
    }

    const { data, error } = await supabase
      .from('questions')
      .insert(payload)
      .select('*')
      .single();

    if (error) throw new Error(`Erreur création question : ${error.message}`);
    return normalizeQuestion(data as Record<string, unknown>);
  },

  async updateQuestion(questionId: string, patch: UpdateQuestionInput): Promise<Question> {
    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      const idx = db.questions.findIndex((q) => q.id === questionId);
      if (idx === -1) throw new Error('Question introuvable');
      const updated: Question = {
        ...db.questions[idx],
        ...patch,
        correct_option:
          patch.correct_option !== undefined
            ? patch.correct_option?.trim() || null
            : db.questions[idx].correct_option,
      };
      db.questions[idx] = updated;
      await writeLocalDb(db, updated.session_id);
      return updated;
    }

    const { data, error } = await supabase
      .from('questions')
      .update(patch)
      .eq('id', questionId)
      .select('*')
      .single();

    if (error) throw new Error(`Erreur modification question : ${error.message}`);
    return normalizeQuestion(data as Record<string, unknown>);
  },

  async deleteQuestion(questionId: string): Promise<void> {
    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      const target = db.questions.find((q) => q.id === questionId);
      db.questions = db.questions.filter((q) => q.id !== questionId);
      db.votes = db.votes.filter((v) => v.question_id !== questionId);
      db.sessions = db.sessions.map((s) =>
        s.active_question_id === questionId ? { ...s, active_question_id: null } : s
      );
      await writeLocalDb(db, target?.session_id);
      return;
    }

    const { error } = await supabase.from('questions').delete().eq('id', questionId);
    if (error) throw new Error(`Erreur suppression question : ${error.message}`);
  },

  /**
   * Lance une question sur la session : ouvre les votes de la question et la définit comme
   * `active_question_id` de la session en cours.
   */
  async launchQuestion(sessionId: string, questionId: string): Promise<Session> {
    await this.updateQuestion(questionId, { is_open: true });
    return await this.updateSessionState(sessionId, {
      active_question_id: questionId,
      show_results: true,
      reveal_answer: false,
    });
  },

  /**
   * Lance instantanément un vote de texte/résolution (OUI / NON / ABSTENTION)
   * sur la diapositive PowerPoint en cours.
   */
  async launchResolutionVote(
    sessionId: string,
    slideNumber: number,
    slideTextOrTitle?: string
  ): Promise<{ question: Question; session: Session }> {
    const cleanTitle =
      slideTextOrTitle?.trim() || `Vote du texte — Diapositive ${slideNumber}`;

    const question = await this.createQuestion({
      session_id: sessionId,
      title: cleanTitle,
      type: 'mcq',
      options: ['OUI', 'NON', 'ABSTENTION'],
      correct_option: null,
      slide_number: slideNumber,
      is_open: true,
      order_index: slideNumber,
    });

    const session = await this.updateSessionState(sessionId, {
      current_slide: slideNumber,
      active_question_id: question.id,
      show_results: true,
      reveal_answer: false,
    });

    return { question, session };
  },

  /**
   * Crée et lance instantanément un Sondage Express sur la diapositive en cours.
   */
  async createAndLaunchExpressPoll(
    sessionId: string,
    slideNumber: number,
    preset: 'mcq4' | 'tf' | 'scale' | 'open'
  ): Promise<{ question: Question; session: Session }> {
    let title = `Sondage Express — Diapositive ${slideNumber}`;
    let type: Question['type'] = 'mcq';
    let options: string[] = ['Option A', 'Option B', 'Option C', 'Option D'];

    if (preset === 'tf') {
      title = `Vrai ou Faux — Diapositive ${slideNumber}`;
      type = 'tf';
      options = ['Vrai', 'Faux'];
    } else if (preset === 'scale') {
      title = `Évaluation (1 à 5) — Diapositive ${slideNumber}`;
      type = 'scale';
      options = ['1', '2', '3', '4', '5'];
    } else if (preset === 'open') {
      title = `Question ouverte — Diapositive ${slideNumber}`;
      type = 'open';
      options = [];
    }

    const question = await this.createQuestion({
      session_id: sessionId,
      title,
      type,
      options,
      correct_option: null,
      slide_number: slideNumber,
      is_open: true,
      order_index: 999,
    });

    const session = await this.updateSessionState(sessionId, {
      active_question_id: question.id,
      show_results: true,
      reveal_answer: false,
    });

    return { question, session };
  },

  // --------------------------------------------------------------------------
  // PARTICIPANTS
  // --------------------------------------------------------------------------
  async getParticipantsBySession(sessionId: string): Promise<Participant[]> {
    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      return db.participants
        .filter((p) => p.session_id === sessionId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    const { data, error } = await supabase
      .from('participants')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) throw new Error(`Erreur chargement participants : ${error.message}`);
    return (data as Participant[]) ?? [];
  },

  async getParticipantById(participantId: string): Promise<Participant | null> {
    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      return db.participants.find((p) => p.id === participantId) ?? null;
    }

    const { data, error } = await supabase
      .from('participants')
      .select('*')
      .eq('id', participantId)
      .maybeSingle();

    if (error) return null;
    return (data as Participant) ?? null;
  },

  async joinSession(
    sessionId: string,
    nickname: string,
    existingParticipantId?: string | null
  ): Promise<Participant> {
    const cleanName = nickname.trim();
    if (!cleanName) throw new Error('Le pseudo est requis.');

    // Vérifie si le participant existe déjà pour cette session (par ID ou par Nom/Prénom identique)
    if (existingParticipantId) {
      const existing = await this.getParticipantById(existingParticipantId);
      if (existing && existing.session_id === sessionId) {
        return existing;
      }
    }

    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      const normalizedNickname = cleanName.toLowerCase();
      const existingByName = db.participants.find(
        (p) =>
          p.session_id === sessionId &&
          p.nickname.trim().toLowerCase() === normalizedNickname
      );
      if (existingByName) {
        return existingByName;
      }

      const participant: Participant = {
        id: generateUUID(),
        session_id: sessionId,
        nickname: cleanName,
        created_at: new Date().toISOString(),
      };
      db.participants.push(participant);
      await writeLocalDb(db, sessionId);
      return participant;
    }

    const { data, error } = await supabase
      .from('participants')
      .insert({
        session_id: sessionId,
        nickname: cleanName,
      })
      .select('*')
      .single();

    if (error) throw new Error(`Erreur d'inscription : ${error.message}`);
    return data as Participant;
  },

  // --------------------------------------------------------------------------
  // VOTES (Garantie : 1 seul vote unique et définitif par participant et par scrutin)
  // --------------------------------------------------------------------------
  async getVotesBySession(sessionId: string): Promise<Vote[]> {
    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      return db.votes
        .filter((v) => v.session_id === sessionId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    const { data, error } = await supabase
      .from('votes')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) throw new Error(`Erreur chargement votes : ${error.message}`);
    return (data as Vote[]) ?? [];
  },

  async getParticipantVoteForQuestion(
    questionId: string,
    participantId: string
  ): Promise<Vote | null> {
    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      const direct = db.votes.find(
        (v) => v.question_id === questionId && v.participant_id === participantId
      );
      if (direct) return direct;

      const voter = db.participants.find((p) => p.id === participantId);
      if (voter) {
        const normName = voter.nickname.trim().toLowerCase();
        const sameNameIds = new Set(
          db.participants
            .filter(
              (p) =>
                p.session_id === voter.session_id &&
                p.nickname.trim().toLowerCase() === normName
            )
            .map((p) => p.id)
        );
        return (
          db.votes.find(
            (v) => v.question_id === questionId && sameNameIds.has(v.participant_id)
          ) ?? null
        );
      }
      return null;
    }

    const { data, error } = await supabase
      .from('votes')
      .select('*')
      .eq('question_id', questionId)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (error) return null;
    return (data as Vote) ?? null;
  },

  async submitVote(params: {
    session_id: string;
    question_id: string;
    participant_id: string;
    answer: string;
  }): Promise<Vote> {
    const cleanAnswer = params.answer.trim();
    if (!cleanAnswer) throw new Error('La réponse ne peut pas être vide.');

    if (!isSupabaseConfigured) {
      const db = await readLocalDb();
      const voter = db.participants.find((p) => p.id === params.participant_id);
      const normName = voter?.nickname.trim().toLowerCase() ?? '';
      const sameNameIds = new Set(
        normName
          ? db.participants
              .filter(
                (p) =>
                  p.session_id === params.session_id &&
                  p.nickname.trim().toLowerCase() === normName
              )
              .map((p) => p.id)
          : [params.participant_id]
      );
      sameNameIds.add(params.participant_id);

      const existingVote = db.votes.find(
        (v) =>
          v.question_id === params.question_id && sameNameIds.has(v.participant_id)
      );

      // Verrouillage strict : si ce participant a déjà voté pour ce scrutin, on conserve son 1er vote définitif
      if (existingVote) {
        return existingVote;
      }

      const newVote: Vote = {
        id: generateUUID(),
        session_id: params.session_id,
        question_id: params.question_id,
        participant_id: params.participant_id,
        answer: cleanAnswer,
        created_at: new Date().toISOString(),
      };
      db.votes.push(newVote);
      await writeLocalDb(db, params.session_id);
      return newVote;
    }

    const { data, error } = await supabase
      .from('votes')
      .upsert(
        {
          session_id: params.session_id,
          question_id: params.question_id,
          participant_id: params.participant_id,
          answer: cleanAnswer,
        },
        { onConflict: 'question_id,participant_id' }
      )
      .select('*')
      .single();

    if (error) throw new Error(`Erreur d'envoi du vote : ${error.message}`);
    return data as Vote;
  },

  // --------------------------------------------------------------------------
  // ABONNEMENT TEMPS RÉEL (Supabase Realtime WebSockets ou /api/db Wi-Fi local)
  // --------------------------------------------------------------------------
  subscribeToSessionRealtime(
    sessionId: string,
    callbacks: SessionRealtimeCallbacks
  ): () => void {
    let lastSnapshot = '';

    const refreshAll = async (force = false) => {
      try {
        const db = await readLocalDb();
        const s = db.sessions.find((x) => x.id === sessionId) ?? null;
        const q = db.questions
          .filter((x) => x.session_id === sessionId)
          .sort((a, b) => a.order_index - b.order_index || a.created_at.localeCompare(b.created_at));
        const p = db.participants
          .filter((x) => x.session_id === sessionId)
          .sort((a, b) => a.created_at.localeCompare(b.created_at));
        const v = db.votes
          .filter((x) => x.session_id === sessionId)
          .sort((a, b) => a.created_at.localeCompare(b.created_at));

        const snapshot = JSON.stringify({ s, q, p, v });
        if (!force && snapshot === lastSnapshot) {
          return;
        }
        lastSnapshot = snapshot;

        if (s && callbacks.onSessionUpdate) {
          callbacks.onSessionUpdate(s);
        }
        if (callbacks.onQuestionsChange) {
          callbacks.onQuestionsChange(q);
        }
        if (callbacks.onParticipantsChange) {
          callbacks.onParticipantsChange(p);
        }
        if (callbacks.onVotesChange) {
          callbacks.onVotesChange(v);
        }
      } catch (err) {
        console.error('[Realtime Refresh Error]', err);
      }
    };

    if (!isSupabaseConfigured) {
      const handleLocalEvent = () => {
        void refreshAll(true);
      };
      window.addEventListener('pulseslide-local-update', handleLocalEvent);
      window.addEventListener('storage', handleLocalEvent);

      let bc: BroadcastChannel | null = null;
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
        bc.onmessage = () => {
          void refreshAll(true);
        };
      }

      const pollTimer = window.setInterval(() => {
        void refreshAll(false);
      }, 800);

      return () => {
        window.clearInterval(pollTimer);
        window.removeEventListener('pulseslide-local-update', handleLocalEvent);
        window.removeEventListener('storage', handleLocalEvent);
        if (bc) bc.close();
      };
    }

    const channel = supabase
      .channel(`session-live-${sessionId}-${Math.random().toString(36).slice(2, 7)}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'sessions',
          filter: `id=eq.${sessionId}`,
        },
        async (payload) => {
          if (payload.new && callbacks.onSessionUpdate) {
            callbacks.onSessionUpdate(payload.new as Session);
          }
          if (callbacks.onQuestionsChange) {
            const list = await this.getQuestionsBySession(sessionId);
            callbacks.onQuestionsChange(list);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'questions',
          filter: `session_id=eq.${sessionId}`,
        },
        async () => {
          if (callbacks.onQuestionsChange) {
            const list = await this.getQuestionsBySession(sessionId);
            callbacks.onQuestionsChange(list);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'participants',
          filter: `session_id=eq.${sessionId}`,
        },
        async () => {
          if (callbacks.onParticipantsChange) {
            const list = await this.getParticipantsBySession(sessionId);
            callbacks.onParticipantsChange(list);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'votes',
          filter: `session_id=eq.${sessionId}`,
        },
        async () => {
          if (callbacks.onVotesChange) {
            const list = await this.getVotesBySession(sessionId);
            callbacks.onVotesChange(list);
          }
        }
      )
      .subscribe();

    const sbPollTimer =
      typeof window !== 'undefined'
        ? window.setInterval(async () => {
            try {
              if (callbacks.onSessionUpdate) {
                const s = await this.getSessionById(sessionId);
                if (s) callbacks.onSessionUpdate(s);
              }
              if (callbacks.onQuestionsChange) {
                const q = await this.getQuestionsBySession(sessionId);
                callbacks.onQuestionsChange(q);
              }
              if (callbacks.onVotesChange) {
                const v = await this.getVotesBySession(sessionId);
                callbacks.onVotesChange(v);
              }
            } catch {
              // Ignorer erreurs réseau temporaires sur GSM
            }
          }, 2500)
        : null;

    return () => {
      if (sbPollTimer !== null && typeof window !== 'undefined') {
        window.clearInterval(sbPollTimer);
      }
      void supabase.removeChannel(channel);
    };
  },

  // --------------------------------------------------------------------------
  // EXPORT CSV DE LA SESSION
  // --------------------------------------------------------------------------
  exportSessionResultsToCsv(
    session: Session,
    questions: Question[],
    participants: Participant[],
    votes: Vote[]
  ): void {
    const realQuestions = questions.filter((q) => q.title !== '__SLIDE_PREVIEW__');
    const questionMap = new Map(realQuestions.map((q) => [q.id, q]));
    const participantMap = new Map(participants.map((p) => [p.id, p]));

    const escapeCsv = (val: string | number | null | undefined): string => {
      const str = val === null || val === undefined ? '' : String(val);
      return `"${str.replace(/"/g, '""')}"`;
    };

    const headers = [
      'Session',
      'Code Session',
      'Question',
      'Type',
      'Diapositive Associée',
      'Participant',
      'Réponse Donnée',
      'Bonne Réponse Attendue',
      'Résultat (Bonne/Mauvaise réponse)',
      'Horodatage',
    ];

    const rows: string[] = [headers.map(escapeCsv).join(';')];

    for (const vote of votes) {
      const q = questionMap.get(vote.question_id);
      const p = participantMap.get(vote.participant_id);

      let correctness = 'Sondage (sans bonne réponse)';
      const validCorrectOption =
        q?.correct_option && !q.correct_option.startsWith('data:image/')
          ? q.correct_option
          : null;
      if (validCorrectOption) {
        const isCorrect =
          vote.answer.trim().toLowerCase() === validCorrectOption.trim().toLowerCase();
        correctness = isCorrect ? 'Bonne réponse' : 'Mauvaise réponse';
      }

      const formattedDate = new Date(vote.created_at).toLocaleString('fr-FR');

      rows.push(
        [
          session.title,
          session.code,
          q?.title ?? 'Question supprimée',
          q?.type.toUpperCase() ?? '',
          q?.slide_number ?? '-',
          p?.nickname ?? 'Anonyme',
          vote.answer,
          validCorrectOption ?? '-',
          correctness,
          formattedDate,
        ]
          .map(escapeCsv)
          .join(';')
      );
    }

    // Si aucun vote n'a encore été enregistré, on exporte au moins la liste des questions préparées
    if (votes.length === 0) {
      for (const q of realQuestions) {
        const validCorrectOption =
          q.correct_option && !q.correct_option.startsWith('data:image/')
            ? q.correct_option
            : null;
        rows.push(
          [
            session.title,
            session.code,
            q.title,
            q.type.toUpperCase(),
            q.slide_number ?? '-',
            '- (Aucun vote)',
            '-',
            validCorrectOption ?? '-',
            '-',
            '-',
          ]
            .map(escapeCsv)
            .join(';')
        );
      }
    }

    const csvContent = '\uFEFF' + rows.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute(
      'download',
      `resultats_${session.code}_${new Date().toISOString().slice(0, 10)}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  },
};
