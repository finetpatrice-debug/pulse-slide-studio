import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';

function getLocalLanIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const netList = interfaces[name];
    if (!netList) continue;
    for (const net of netList) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

interface DbShape {
  sessions: Array<Record<string, unknown>>;
  questions: Array<Record<string, unknown>>;
  participants: Array<Record<string, unknown>>;
  votes: Array<Record<string, unknown>>;
}

const DB_FILE = path.resolve(process.cwd(), '.local-vote-db.json');

function loadServerDb(): DbShape {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')) as DbShape;
    }
  } catch {}
  const initial: DbShape = {
    sessions: [
      {
        id: '7cd937da-c15d-44d0-8329-e77be4d47a84',
        code: '38NKMQ',
        title: 'Séance de Vote PowerPoint',
        current_slide: 1,
        active_question_id: '74295522-4f4f-4305-84ac-de9f070370db',
        show_results: true,
        reveal_answer: false,
        is_active: true,
        created_at: new Date().toISOString(),
      },
    ],
    questions: [
      {
        id: '74295522-4f4f-4305-84ac-de9f070370db',
        session_id: '7cd937da-c15d-44d0-8329-e77be4d47a84',
        title: "PROPOSITION-CADRE — COMMISSION DE L'ENSEIGNEMENT",
        type: 'mcq',
        options: ['OUI', 'NON', 'ABSTENTION'],
        correct_option: null,
        slide_number: 1,
        is_open: true,
        order_index: 1,
        created_at: new Date().toISOString(),
      },
    ],
    participants: [],
    votes: [],
  };
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf-8');
  } catch {}
  return initial;
}

function saveServerDb(db: DbShape) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch {}
}

function getSupabaseAdminClient() {
  try {
    const env = loadEnv('development', process.cwd(), '');
    const url = (env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
    const key = (env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim();
    if (url && key && !url.includes('votre-projet') && !key.includes('votre-cle')) {
      return createClient(url, key);
    }
  } catch {}
  return null;
}

function localVoteApiPlugin(): Plugin {
  let db = loadServerDb();
  let pendingPptCommand: string | null = null;

  return {
    name: 'local-vote-api-middleware',
    configureServer(server) {
      server.middlewares.use('/api/ppt-action', async (req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');

        try {
          const urlObj = new URL(req.url || '', 'http://localhost:5173');
          const op = urlObj.searchParams.get('op') || 'status';
          const slideNum = Math.max(1, Number(urlObj.searchParams.get('slide') || '1') || 1);
          const rawTitle = (urlObj.searchParams.get('title') || '').trim();
          const sb = getSupabaseAdminClient();

          if (op === 'queue') {
            pendingPptCommand = urlObj.searchParams.get('cmd') || null;
            res.statusCode = 200;
            res.end('QUEUED|' + String(pendingPptCommand));
            return;
          }

          db = loadServerDb();
          if (!db.sessions || db.sessions.length === 0) {
            db.sessions = [
              {
                id: '7cd937da-c15d-44d0-8329-e77be4d47a84',
                code: '38NKMQ',
                title: 'Séance de Vote PowerPoint',
                current_slide: slideNum,
                active_question_id: null,
                show_results: false,
                reveal_answer: false,
                is_active: true,
                created_at: new Date().toISOString(),
              },
            ];
          }
          const session = db.sessions[0];

          const getStatsForQuestion = (qId: string) => {
            const qVotes = (db.votes || []).filter((v) => String(v.question_id) === qId);
            const total = qVotes.length;
            let ouiCount = 0;
            let nonCount = 0;
            let abstCount = 0;
            for (const v of qVotes) {
              const ans = String(v.answer || '').trim().toUpperCase();
              if (ans === 'OUI') ouiCount++;
              else if (ans === 'NON') nonCount++;
              else abstCount++;
            }
            const ouiPct = total > 0 ? Math.round((ouiCount / total) * 100) : 0;
            const nonPct = total > 0 ? Math.round((nonCount / total) * 100) : 0;
            const abstPct = total > 0 ? Math.round((abstCount / total) * 100) : 0;
            return { total, ouiCount, nonCount, abstCount, ouiPct, nonPct, abstPct };
          };

          const activeQId = session.active_question_id ? String(session.active_question_id) : null;
          const activeQ = activeQId
            ? (db.questions || []).find((q) => String(q.id) === activeQId)
            : null;
          const isOpen = Boolean(activeQ && activeQ.is_open === true);

          const syncSlidePreviewToSupabase = async (targetSlide: number) => {
            if (!sb) return;
            try {
              const slideFile = path.resolve(
                process.cwd(),
                'public',
                'slides',
                `slide-${targetSlide}.png`
              );
              if (!fs.existsSync(slideFile)) return;
              const buf = fs.readFileSync(slideFile);
              if (buf.length <= 0 || buf.length >= 1500000) return;
              const slideDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
              const previewId =
                '00000000-0000-4000-8000-' + String(targetSlide).padStart(12, '0');
              await sb.from('questions').upsert({
                id: previewId,
                session_id: String(session.id),
                title: '__SLIDE_PREVIEW__',
                type: 'mcq',
                options: ['OUI', 'NON', 'ABSTENTION'],
                correct_option: slideDataUrl,
                slide_number: targetSlide,
                is_open: false,
                order_index: -targetSlide,
              });
            } catch {}
          };

          if (op === 'slide') {
            if (session.current_slide !== slideNum) {
              session.current_slide = slideNum;
              saveServerDb(db);
              if (sb) {
                try {
                  await sb.from('sessions').upsert({
                    id: String(session.id),
                    code: String(session.code || '38NKMQ'),
                    title: String(session.title || 'Séance de Vote PowerPoint'),
                    current_slide: slideNum,
                    active_question_id: session.active_question_id || null,
                    show_results: Boolean(session.show_results),
                    reveal_answer: false,
                    is_active: true,
                  });
                } catch {}
              }
            }
            void syncSlidePreviewToSupabase(slideNum);
            res.statusCode = 200;
            res.end('OK');
            return;
          }

          if (op === 'status') {
            if (session.current_slide !== slideNum) {
              session.current_slide = slideNum;
              saveServerDb(db);
              if (sb) {
                void sb
                  .from('sessions')
                  .update({ current_slide: slideNum })
                  .eq('id', String(session.id));
              }
              void syncSlidePreviewToSupabase(slideNum);
            }
            if (pendingPptCommand) {
              const cmdToRun = pendingPptCommand;
              pendingPptCommand = null;
              res.statusCode = 200;
              res.end(`CMD|${cmdToRun}`);
              return;
            }
            if (isOpen && activeQ) {
              if (sb) {
                try {
                  const { data: sbVotes } = await sb
                    .from('votes')
                    .select('*')
                    .eq('question_id', String(activeQ.id));
                  if (Array.isArray(sbVotes)) {
                    const otherVotes = (db.votes || []).filter(
                      (v) => String(v.question_id) !== String(activeQ.id)
                    );
                    db.votes = [...otherVotes, ...(sbVotes as Array<Record<string, unknown>>)];
                    saveServerDb(db);
                  }
                } catch {}
              }
              const st = getStatsForQuestion(String(activeQ.id));
              res.statusCode = 200;
              res.end(`OPEN|${st.total}|${st.ouiCount}|${st.nonCount}|${st.abstCount}`);
              return;
            }
            res.statusCode = 200;
            res.end('CLOSED|0|0|0|0');
            return;
          }

          if (op === 'reset') {
            const slideQuestionIds = new Set(
              (db.questions || [])
                .filter((q) => Number(q.slide_number) === slideNum || String(q.id) === activeQId)
                .map((q) => String(q.id))
            );
            db.questions = (db.questions || []).filter((q) => !slideQuestionIds.has(String(q.id)));
            db.votes = (db.votes || []).filter((v) => !slideQuestionIds.has(String(v.question_id)));
            for (const q of db.questions) {
              q.is_open = false;
            }
            session.current_slide = slideNum;
            session.active_question_id = null;
            session.show_results = false;
            saveServerDb(db);

            if (sb) {
              try {
                await sb
                  .from('sessions')
                  .update({ active_question_id: null, show_results: false, current_slide: slideNum })
                  .eq('id', String(session.id));
                for (const qId of slideQuestionIds) {
                  await sb.from('questions').delete().eq('id', qId);
                }
              } catch {}
            }

            res.statusCode = 200;
            res.end('RESET|0|0|0|0');
            return;
          }

          if (op === 'click') {
            if (!isOpen) {
              // 1er clic : OUVRIR LE VOTE SUR CE SLIDE
              for (const q of db.questions || []) {
                q.is_open = false;
              }
              const newId = crypto.randomUUID();
              const qTitle =
                rawTitle.length > 0
                  ? rawTitle
                  : `Proposition soumise au vote — Diapositive n°${slideNum}`;
              let slideDataUrl: string | null = null;
              try {
                const slideFile = path.resolve(
                  process.cwd(),
                  'public',
                  'slides',
                  `slide-${slideNum}.png`
                );
                if (fs.existsSync(slideFile)) {
                  const buf = fs.readFileSync(slideFile);
                  if (buf.length > 0 && buf.length < 1500000) {
                    slideDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
                  }
                }
              } catch {}
              const newQ: Record<string, unknown> = {
                id: newId,
                session_id: String(session.id),
                title: qTitle,
                type: 'mcq',
                options: ['OUI', 'NON', 'ABSTENTION'],
                correct_option: slideDataUrl,
                slide_number: slideNum,
                is_open: true,
                order_index: (db.questions || []).length + 1,
                created_at: new Date().toISOString(),
              };
              db.questions.push(newQ);
              session.current_slide = slideNum;
              session.active_question_id = newId;
              session.show_results = false;
              saveServerDb(db);

              if (sb) {
                try {
                  await Promise.all([
                    sb
                      .from('questions')
                      .update({ is_open: false })
                      .eq('session_id', String(session.id)),
                    sb.from('questions').insert(newQ),
                  ]);
                  await sb
                    .from('sessions')
                    .update({
                      active_question_id: newId,
                      show_results: false,
                      current_slide: slideNum,
                    })
                    .eq('id', String(session.id));
                } catch {}
              }

              res.statusCode = 200;
              res.end('OPENED|0|0|0|0');
              return;
            } else if (activeQ) {
              // 2e clic : CLÔTURER LE VOTE & RENVOYER LES RÉSULTATS POUR INSÉRER LA DIAPO
              if (sb) {
                try {
                  const { data: sbVotes } = await sb
                    .from('votes')
                    .select('*')
                    .eq('question_id', String(activeQ.id));
                  if (Array.isArray(sbVotes)) {
                    const otherVotes = (db.votes || []).filter(
                      (v) => String(v.question_id) !== String(activeQ.id)
                    );
                    db.votes = [...otherVotes, ...(sbVotes as Array<Record<string, unknown>>)];
                  }
                  await sb.from('questions').update({ is_open: false }).eq('id', String(activeQ.id));
                  await sb
                    .from('sessions')
                    .update({ active_question_id: null, show_results: true })
                    .eq('id', String(session.id));
                } catch {}
              }

              activeQ.is_open = false;
              session.active_question_id = null;
              session.show_results = true;
              const st = getStatsForQuestion(String(activeQ.id));
              const qTitle = String(activeQ.title || `Diapositive ${slideNum}`).replace(/\|/g, '-');
              const sCode = String(session.code || '38NKMQ');
              saveServerDb(db);
              setTimeout(() => {
                void syncSlidePreviewToSupabase(slideNum);
                void syncSlidePreviewToSupabase(slideNum + 1);
              }, 800);

              res.statusCode = 200;
              res.end(
                `CLOSED_INSERT|${st.total}|${st.ouiCount}|${st.ouiPct}|${st.nonCount}|${st.nonPct}|${st.abstCount}|${st.abstPct}|${sCode}|${qTitle}`
              );
              return;
            }
          }

          res.statusCode = 200;
          res.end('CLOSED|0|0|0|0');
        } catch (err) {
          res.statusCode = 500;
          res.end('ERR|' + String(err));
        }
      });

      server.middlewares.use('/api/db', (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.statusCode = 200;
          res.end();
          return;
        }

        if (req.method === 'GET') {
          db = loadServerDb();
          res.statusCode = 200;
          res.end(JSON.stringify(db));
          return;
        }

        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const payload = JSON.parse(body || '{}');
              db = loadServerDb();

              if (payload.action === 'SYNC_FROM_CLIENT' && payload.clientDb) {
                // Le serveur (.local-vote-db.json) est la seule source de vérité
                saveServerDb(db);
              } else if (payload.action === 'WRITE_DB' && payload.db) {
                const incoming = payload.db as DbShape;
                // Garantie serveur : un vote déjà enregistré pour (question_id, participant_id) est immuable
                const existingVotesMap = new Map<string, Record<string, unknown>>();
                for (const oldVote of db.votes || []) {
                  const key = `${String(oldVote.question_id)}::${String(oldVote.participant_id)}`;
                  existingVotesMap.set(key, oldVote);
                }
                const sanitizedVotes: Array<Record<string, unknown>> = [];
                const seenKeys = new Set<string>();
                for (const v of incoming.votes || []) {
                  const key = `${String(v.question_id)}::${String(v.participant_id)}`;
                  if (seenKeys.has(key)) continue;
                  seenKeys.add(key);
                  const lockedVote = existingVotesMap.get(key);
                  sanitizedVotes.push(lockedVote ? lockedVote : v);
                }
                incoming.votes = sanitizedVotes;
                db = incoming;
                saveServerDb(db);
              } else if (payload.action === 'SAVE_QR_PNG' && typeof payload.dataUrl === 'string') {
                try {
                  const base64 = payload.dataUrl.replace(/^data:image\/png;base64,/, '');
                  const slidesDir = path.resolve(process.cwd(), 'public', 'slides');
                  fs.mkdirSync(slidesDir, { recursive: true });
                  fs.writeFileSync(path.join(slidesDir, 'qr-session.png'), Buffer.from(base64, 'base64'));
                } catch {}
              }

              res.statusCode = 200;
              res.end(JSON.stringify(db));
            } catch (err) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
      });
    },
  };
}

const localIp = getLocalLanIp();

export default defineConfig({
  plugins: [react(), localVoteApiPlugin()],
  server: {
    host: true,
    port: 5173,
  },
  define: {
    __LOCAL_LAN_IP__: JSON.stringify(localIp),
  },
});
