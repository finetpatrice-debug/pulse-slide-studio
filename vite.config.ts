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
const VOTERS_CSV_FILE = path.resolve(process.cwd(), 'liste-votants.csv');
const PUBLIC_REGIE_URL = 'https://finetpatrice-debug.github.io/pulse-slide-studio/regie';
const COHOST_CONFIG_PREFIX = 'COHOST_CFG_';

function hashCohostPinServer(sessionCode: string, pin: string): string {
  const normalizedCode = (sessionCode || '38NKMQ').trim().toUpperCase();
  const digest = crypto
    .createHash('sha256')
    .update(`pulseslide-regie-v1|${normalizedCode}|${pin.trim()}`, 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

interface AllowedVoterEntry {
  email: string;
  name: string;
}

function parseVoterLine(rawLine: string): AllowedVoterEntry | null {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;
  const parts = line.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const emailPart = parts.find((p) => p.includes('@')) || parts[0];
  const email = emailPart.toLowerCase().trim();
  if (!email.includes('@')) return null;
  const namePart = parts.find((p) => p !== emailPart);
  const defaultName = email
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    email,
    name: (namePart || defaultName).trim(),
  };
}

function loadAllowedVotersFromCsv(): AllowedVoterEntry[] {
  try {
    if (!fs.existsSync(VOTERS_CSV_FILE)) return [];
    const raw = fs.readFileSync(VOTERS_CSV_FILE, 'utf-8');
    const seen = new Set<string>();
    const list: AllowedVoterEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseVoterLine(line);
      if (parsed && !seen.has(parsed.email)) {
        seen.add(parsed.email);
        list.push(parsed);
      }
    }
    return list;
  } catch {
    return [];
  }
}

function extractEmailFromNickname(nickname: string): string {
  const m = (nickname || '').match(/<([^>]+@[^>]+)>/);
  if (m) return m[1].toLowerCase().trim();
  const raw = (nickname || '').replace(/\s*#\d{4}\s*$/, '').trim();
  if (raw.includes('@')) return raw.toLowerCase();
  return '';
}

function formatUnclaimedNickname(entry: AllowedVoterEntry): string {
  return `${entry.name} <${entry.email}> #0000`;
}

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
    const url = (
      env.VITE_SUPABASE_URL ||
      process.env.VITE_SUPABASE_URL ||
      'https://ztjppnonfccdytvgpqrl.supabase.co'
    ).trim();
    const key = (
      env.VITE_SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      'sb_publishable_kaNBOm-Q29rHSWImjMnWAg_E0QB16Eu'
    ).trim();
    if (url && key && !url.includes('votre-projet') && !key.includes('votre-cle')) {
      return createClient(url, key);
    }
  } catch {}
  return null;
}

function localVoteApiPlugin(): Plugin {
  let db = loadServerDb();
  let pendingPptCommand: string | null = null;
  let lastSbVotesSyncMs = 0;

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

          const readSlideDataUrl = (targetSlide: number): string | null => {
            try {
              const p = path.resolve(process.cwd(), 'public', 'slides', `slide-${targetSlide}.png`);
              if (!fs.existsSync(p)) return null;
              return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
            } catch {
              return null;
            }
          };

          const activeQId = session.active_question_id ? String(session.active_question_id) : null;
          const activeQ = activeQId
            ? (db.questions || []).find((q) => String(q.id) === activeQId)
            : null;
          const isOpen = Boolean(activeQ && activeQ.is_open === true);

          if (op === 'slide') {
            if (session.current_slide !== slideNum) {
              session.current_slide = slideNum;
              saveServerDb(db);
              if (sb) {
                void sb
                  .from('sessions')
                  .update({ current_slide: slideNum })
                  .eq('id', String(session.id));
              }
            }
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
            }
            if (pendingPptCommand) {
              const cmdToRun = pendingPptCommand;
              pendingPptCommand = null;
              res.statusCode = 200;
              res.end(`CMD|${cmdToRun}`);
              return;
            }
            if (isOpen && activeQ) {
              const nowMs = Date.now();
              if (sb && nowMs - lastSbVotesSyncMs >= 2000) {
                lastSbVotesSyncMs = nowMs;
                void (async () => {
                  try {
                    const { data: sbVotes } = await sb
                      .from('votes')
                      .select('id, session_id, question_id, participant_id, answer, created_at')
                      .eq('question_id', String(activeQ.id));
                    if (Array.isArray(sbVotes)) {
                      const latestDb = loadServerDb();
                      const otherVotes = (latestDb.votes || []).filter(
                        (v) => String(v.question_id) !== String(activeQ.id)
                      );
                      latestDb.votes = [
                        ...otherVotes,
                        ...(sbVotes as Array<Record<string, unknown>>),
                      ];
                      saveServerDb(latestDb);
                    }
                  } catch {}
                })();
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

          const syncCsvVotersToSupabaseAndLocal = async (
            resetPins: boolean,
            newTitle?: string,
            pruneRemoved?: boolean
          ) => {
            const csvVoters = loadAllowedVotersFromCsv();
            const allowedEmailSet = new Set(csvVoters.map((v) => v.email));
            const sessionIdStr = String(session.id);

            if (newTitle) {
              session.title = newTitle;
              session.active_question_id = null;
              session.show_results = false;
              for (const q of db.questions || []) {
                q.is_open = false;
              }
            }

            let sbParticipants: Array<Record<string, unknown>> = [];
            if (sb) {
              try {
                const { data } = await sb
                  .from('participants')
                  .select('*')
                  .eq('session_id', sessionIdStr);
                if (Array.isArray(data)) sbParticipants = data;
              } catch {}
            }

            // Fusion non destructive : intégrer dans liste-votants.csv les retardataires ajoutés depuis /regie dans Supabase
            if (!pruneRemoved && sbParticipants.length > 0) {
              const newFromSupabase: AllowedVoterEntry[] = [];
              for (const p of sbParticipants) {
                const rawNick = String(p.nickname || '');
                const em = extractEmailFromNickname(rawNick);
                if (em && !allowedEmailSet.has(em)) {
                  allowedEmailSet.add(em);
                  const cleanName =
                    rawNick
                      .replace(/\s*<[^>]+>\s*/g, ' ')
                      .replace(/\s*#\d{4}\s*$/, '')
                      .trim() || em.split('@')[0];
                  const entry = { email: em, name: cleanName };
                  csvVoters.push(entry);
                  newFromSupabase.push(entry);
                }
              }
              if (newFromSupabase.length > 0) {
                try {
                  if (!fs.existsSync(VOTERS_CSV_FILE)) {
                    fs.writeFileSync(
                      VOTERS_CSV_FILE,
                      '# Liste officielle des votants autorisés (Format: email;Nom Prénom)\r\n',
                      'utf-8'
                    );
                  }
                  const linesToAppend = newFromSupabase
                    .map((v) => `\r\n${v.email};${v.name}`)
                    .join('');
                  fs.appendFileSync(VOTERS_CSV_FILE, linesToAppend, 'utf-8');
                } catch {}
              }
            }

            // Si pruneRemoved=true (remplacement de la liste par un nouveau fichier Excel/CSV), retirer les participants absents de la nouvelle liste
            if (pruneRemoved) {
              if (sb && sbParticipants.length > 0) {
                const keptSb: Array<Record<string, unknown>> = [];
                for (const p of sbParticipants) {
                  const em = extractEmailFromNickname(String(p.nickname || ''));
                  if (!em || !allowedEmailSet.has(em)) {
                    try {
                      await sb.from('votes').delete().eq('participant_id', String(p.id));
                    } catch {}
                    try {
                      await sb.from('participants').delete().eq('id', String(p.id));
                    } catch {}
                  } else {
                    keptSb.push(p);
                  }
                }
                sbParticipants = keptSb;
              }
              db.participants = (db.participants || []).filter((p) => {
                const em = extractEmailFromNickname(String(p.nickname || ''));
                return Boolean(em && allowedEmailSet.has(em));
              });
            }

            const existingByEmail = new Map<string, Record<string, unknown>>();
            for (const p of sbParticipants.length > 0 ? sbParticipants : (db.participants || [])) {
              const em = extractEmailFromNickname(String(p.nickname || ''));
              if (em && (!pruneRemoved || allowedEmailSet.has(em))) {
                existingByEmail.set(em, p);
              }
            }

            // Si resetPins=true, réinitialiser à #0000 tous les profils existants (sans DELETE pour préserver l'historique des votes)
            if (resetPins && sb) {
              for (const p of sbParticipants) {
                const rawNick = String(p.nickname || '');
                const em = extractEmailFromNickname(rawNick);
                const csvMatch = csvVoters.find((v) => v.email === em);
                const updatedNick = csvMatch
                  ? formatUnclaimedNickname(csvMatch)
                  : rawNick.replace(/#\d{4}\s*$/, '#0000');
                try {
                  await sb.from('participants').update({ nickname: updatedNick }).eq('id', String(p.id));
                  p.nickname = updatedNick;
                } catch {}
              }
            } else if (pruneRemoved && sb) {
              // Mettre à jour les noms des participants conservés si le fichier Excel/CSV a modifié leur nom
              for (const p of sbParticipants) {
                const rawNick = String(p.nickname || '');
                const em = extractEmailFromNickname(rawNick);
                const csvMatch = csvVoters.find((v) => v.email === em);
                if (csvMatch) {
                  const pinMatch = rawNick.match(/#(\d{4})\s*$/);
                  const currentPin = pinMatch ? pinMatch[1] : '0000';
                  const updatedNick = `${csvMatch.name} <${csvMatch.email}> #${currentPin}`;
                  if (updatedNick !== rawNick) {
                    try {
                      await sb.from('participants').update({ nickname: updatedNick }).eq('id', String(p.id));
                      p.nickname = updatedNick;
                    } catch {}
                  }
                }
              }
            }

            // Ajouter en lot (batch insert) les nouveaux e-mails du CSV qui ne sont pas encore dans la base (support instantané 300+ invités)
            const missingEntries = csvVoters.filter((entry) => !existingByEmail.has(entry.email));
            if (missingEntries.length > 0) {
              if (sb) {
                try {
                  const rowsToInsert = missingEntries.map((entry) => ({
                    session_id: sessionIdStr,
                    nickname: formatUnclaimedNickname(entry),
                  }));
                  const { data: insertedRows } = await sb
                    .from('participants')
                    .insert(rowsToInsert)
                    .select('*');
                  if (Array.isArray(insertedRows)) {
                    for (const row of insertedRows) {
                      const rec = row as Record<string, unknown>;
                      const em = extractEmailFromNickname(String(rec.nickname || ''));
                      sbParticipants.push(rec);
                      if (em) existingByEmail.set(em, rec);
                    }
                  }
                } catch {}
              } else {
                for (const entry of missingEntries) {
                  const localP = {
                    id: crypto.randomUUID(),
                    session_id: sessionIdStr,
                    nickname: formatUnclaimedNickname(entry),
                    created_at: new Date().toISOString(),
                  };
                  existingByEmail.set(entry.email, localP);
                }
              }
            }

            if (sb && newTitle) {
              try {
                await sb
                  .from('questions')
                  .update({ is_open: false })
                  .eq('session_id', sessionIdStr);
                await sb
                  .from('sessions')
                  .update({
                    title: newTitle,
                    active_question_id: null,
                    show_results: false,
                  })
                  .eq('id', sessionIdStr);
              } catch {}
            }

            db.participants = Array.from(existingByEmail.values());
            saveServerDb(db);
            return csvVoters.length;
          };

          if (op === 'clear_participants') {
            const newPresTitle = rawTitle
              ? `${rawTitle} (${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })})`
              : `Séance de Vote PowerPoint (${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })})`;
            res.statusCode = 200;
            res.end('CLEARED_PARTICIPANTS');
            void syncCsvVotersToSupabaseAndLocal(true, newPresTitle);
            return;
          }

          if (op === 'purge_all_emails') {
            const sessionIdStr = String(session.id);
            const prevCsvCount = loadAllowedVotersFromCsv().length;
            const prevLocalCount = (db.participants || []).length;
            let prevSbCount = 0;

            if (sb) {
              try {
                const { count } = await sb
                  .from('participants')
                  .select('*', { count: 'exact', head: true })
                  .eq('session_id', sessionIdStr);
                prevSbCount = count || 0;
              } catch {}

              const { error: qErr } = await sb
                .from('questions')
                .update({ is_open: false })
                .eq('session_id', sessionIdStr);
              if (qErr) {
                res.statusCode = 500;
                res.end('ERR|Supabase questions: ' + qErr.message);
                return;
              }

              const { error: sErr } = await sb
                .from('sessions')
                .update({ active_question_id: null, show_results: false })
                .eq('id', sessionIdStr);
              if (sErr) {
                res.statusCode = 500;
                res.end('ERR|Supabase sessions: ' + sErr.message);
                return;
              }

              const { error: vErr } = await sb
                .from('votes')
                .delete()
                .eq('session_id', sessionIdStr);
              if (vErr) {
                res.statusCode = 500;
                res.end('ERR|Supabase votes: ' + vErr.message);
                return;
              }

              const { error: pErr } = await sb
                .from('participants')
                .delete()
                .eq('session_id', sessionIdStr);
              if (pErr) {
                res.statusCode = 500;
                res.end('ERR|Supabase participants: ' + pErr.message);
                return;
              }
            }

            fs.writeFileSync(
              VOTERS_CSV_FILE,
              '# Liste officielle des votants autorisés (Format: email;Nom Prénom)\r\n',
              'utf-8'
            );

            db.participants = [];
            db.votes = [];
            session.active_question_id = null;
            session.show_results = false;
            for (const q of db.questions || []) {
              q.is_open = false;
            }
            saveServerDb(db);

            const deletedCount = Math.max(prevCsvCount, prevLocalCount, prevSbCount);
            res.statusCode = 200;
            res.end(`PURGED|${deletedCount}`);
            return;
          }

          if (op === 'get_cohost_status') {
            const sCode = String(session.code || '38NKMQ').trim().toUpperCase();
            const cfgCode = `${COHOST_CONFIG_PREFIX}${sCode}`;
            let pinHash: string | null = null;
            if (sb) {
              try {
                const { data } = await sb
                  .from('sessions')
                  .select('title')
                  .eq('code', cfgCode)
                  .maybeSingle();
                const t = String((data as { title?: string } | null)?.title || '').trim();
                if (t.startsWith('sha256:')) pinHash = t;
              } catch {}
            }
            if (!pinHash) {
              const localCfg = (db.sessions || []).find(
                (s) => String(s.code || '').toUpperCase() === cfgCode
              );
              const t = String(localCfg?.title || '').trim();
              if (t.startsWith('sha256:')) pinHash = t;
            }
            res.statusCode = 200;
            res.end(`${pinHash ? 'CONFIGURED' : 'UNSET'}|${PUBLIC_REGIE_URL}`);
            return;
          }

          if (op === 'set_cohost_pin') {
            const sCode = String(session.code || '38NKMQ').trim().toUpperCase();
            const cfgCode = `${COHOST_CONFIG_PREFIX}${sCode}`;
            const disable = urlObj.searchParams.get('disable') === '1';
            const rawPin = (urlObj.searchParams.get('pin') || '').trim();

            if (disable) {
              if (sb) {
                const { error: delErr } = await sb.from('sessions').delete().eq('code', cfgCode);
                if (delErr) {
                  res.statusCode = 500;
                  res.end('ERR|Supabase disable PIN: ' + delErr.message);
                  return;
                }
              }
              db.sessions = (db.sessions || []).filter(
                (s) => String(s.code || '').toUpperCase() !== cfgCode
              );
              saveServerDb(db);
              res.statusCode = 200;
              res.end(`DISABLED|${PUBLIC_REGIE_URL}`);
              return;
            }

            if (rawPin.length < 4) {
              res.statusCode = 400;
              res.end('ERR|Le PIN doit contenir au moins 4 caractères.');
              return;
            }

            const hashed = hashCohostPinServer(sCode, rawPin);
            if (sb) {
              const { data: existingCfg, error: selErr } = await sb
                .from('sessions')
                .select('id')
                .eq('code', cfgCode)
                .maybeSingle();
              if (selErr) {
                res.statusCode = 500;
                res.end('ERR|Supabase lecture config PIN: ' + selErr.message);
                return;
              }
              if (existingCfg && (existingCfg as { id?: string }).id) {
                const { error: updErr } = await sb
                  .from('sessions')
                  .update({ title: hashed, is_active: false })
                  .eq('id', String((existingCfg as { id?: string }).id));
                if (updErr) {
                  res.statusCode = 500;
                  res.end('ERR|Supabase mise à jour PIN: ' + updErr.message);
                  return;
                }
              } else {
                const { error: insErr } = await sb.from('sessions').insert({
                  code: cfgCode,
                  title: hashed,
                  current_slide: 1,
                  active_question_id: null,
                  show_results: false,
                  reveal_answer: false,
                  is_active: false,
                });
                if (insErr) {
                  res.statusCode = 500;
                  res.end('ERR|Supabase création PIN: ' + insErr.message);
                  return;
                }
              }
            }

            const localIdx = (db.sessions || []).findIndex(
              (s) => String(s.code || '').toUpperCase() === cfgCode
            );
            if (localIdx !== -1) {
              db.sessions[localIdx].title = hashed;
              db.sessions[localIdx].is_active = false;
            } else {
              db.sessions.push({
                id: crypto.randomUUID(),
                code: cfgCode,
                title: hashed,
                current_slide: 1,
                active_question_id: null,
                show_results: false,
                reveal_answer: false,
                is_active: false,
                created_at: new Date().toISOString(),
              });
            }
            saveServerDb(db);

            res.statusCode = 200;
            res.end(`PIN_SAVED|${PUBLIC_REGIE_URL}`);
            return;
          }

          if (op === 'reload_voters') {
            const prune = urlObj.searchParams.get('prune') === '1';
            const resetPins = urlObj.searchParams.get('reset') === '1';
            const count = await syncCsvVotersToSupabaseAndLocal(resetPins, undefined, prune);
            res.statusCode = 200;
            res.end(`RELOADED|${count}`);
            return;
          }

          if (op === 'add_voter') {
            const rawEmailInput = (urlObj.searchParams.get('email') || '').trim();
            const parsed = parseVoterLine(rawEmailInput);
            if (!parsed) {
              res.statusCode = 400;
              res.end('ERR|Format e-mail invalide');
              return;
            }
            const currentCsv = loadAllowedVotersFromCsv();
            if (!currentCsv.some((v) => v.email === parsed.email)) {
              fs.appendFileSync(VOTERS_CSV_FILE, `\r\n${parsed.email};${parsed.name}`, 'utf-8');
            }
            await syncCsvVotersToSupabaseAndLocal(false);
            res.statusCode = 200;
            res.end(`ADDED|${parsed.name} (${parsed.email})`);
            return;
          }

          if (op === 'list_participants') {
            void (async () => {
              let list: Array<{ nickname?: string }> = (db.participants || []).filter(
                (p) => String(p.session_id) === String(session.id)
              );
              if (list.length === 0) {
                await syncCsvVotersToSupabaseAndLocal(false);
                list = (db.participants || []).filter(
                  (p) => String(p.session_id) === String(session.id)
                );
              }
              if (sb) {
                try {
                  const { data } = await sb
                    .from('participants')
                    .select('id, nickname, created_at')
                    .eq('session_id', String(session.id))
                    .order('created_at', { ascending: true });
                  if (data && data.length > 0) {
                    list = data;
                  }
                } catch {}
              }
              if (list.length === 0) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.end('EMPTY');
                return;
              }
              const lines = list.map((p, idx) => {
                const raw = String(p.nickname || '').trim();
                const m = raw.match(/^(.*?)\s*#(\d{4})\s*$/);
                if (m) {
                  const label = m[1].trim();
                  const pin = m[2];
                  if (pin === '0000') {
                    return `${idx + 1}. ${label}   —   [En attente de 1re connexion]`;
                  }
                  return `${idx + 1}. ${label}   —   CONNECTÉ (Code : #${pin})`;
                }
                return `${idx + 1}. ${raw}`;
              });
              res.statusCode = 200;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end(lines.join('\n'));
            })();
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
              if (Number(q.slide_number) > slideNum) {
                q.slide_number = Number(q.slide_number) - 1;
              }
            }
            session.current_slide = slideNum;
            session.active_question_id = null;
            session.show_results = false;
            saveServerDb(db);

            res.statusCode = 200;
            res.end('RESET|0|0|0|0');

            if (sb) {
              void (async () => {
                try {
                  await sb
                    .from('sessions')
                    .update({
                      active_question_id: null,
                      show_results: false,
                      current_slide: slideNum,
                    })
                    .eq('id', String(session.id));
                  for (const qId of slideQuestionIds) {
                    await sb.from('questions').delete().eq('id', qId);
                  }
                  for (const q of db.questions) {
                    await sb
                      .from('questions')
                      .update({ slide_number: Number(q.slide_number), is_open: false })
                      .eq('id', String(q.id));
                  }
                } catch {}
              })();
            }
            return;
          }

          if (op === 'click') {
            if (!isOpen) {
              // 1er clic : OUVRIR LE VOTE SUR CE SLIDE (avec l'image exacte de la diapositive exportée par PowerPoint)
              const oldSameSlideIds = (db.questions || [])
                .filter((q) => Number(q.slide_number) === slideNum)
                .map((q) => String(q.id));
              if (oldSameSlideIds.length > 0) {
                const oldSet = new Set(oldSameSlideIds);
                db.questions = (db.questions || []).filter((q) => !oldSet.has(String(q.id)));
                db.votes = (db.votes || []).filter((v) => !oldSet.has(String(v.question_id)));
              }
              for (const q of db.questions || []) {
                q.is_open = false;
                q.correct_option = null;
              }
              const newId = crypto.randomUUID();
              const qTitle =
                rawTitle.length > 0
                  ? rawTitle
                  : `Proposition soumise au vote — Diapositive n°${slideNum}`;
              const newQ: Record<string, unknown> = {
                id: newId,
                session_id: String(session.id),
                title: qTitle,
                type: 'mcq',
                options: ['OUI', 'NON', 'ABSTENTION'],
                correct_option: null,
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

              res.statusCode = 200;
              res.end('OPENED|0|0|0|0');

              if (sb) {
                void (async () => {
                  try {
                    for (const oldId of oldSameSlideIds) {
                      await sb.from('questions').delete().eq('id', oldId);
                    }
                    await sb
                      .from('questions')
                      .update({ is_open: false, correct_option: null })
                      .eq('session_id', String(session.id));
                    await sb.from('questions').insert(newQ);
                    await sb
                      .from('sessions')
                      .update({
                        active_question_id: newId,
                        show_results: false,
                        current_slide: slideNum,
                      })
                      .eq('id', String(session.id));
                  } catch {}
                })();
              }
              return;
            } else if (activeQ) {
              // 2e clic : CLÔTURER LE VOTE & AFFICHER LE RÉSULTAT SUR LE GSM ET DANS POWERPOINT
              if (sb) {
                try {
                  const sbVotes = await Promise.race([
                    sb
                      .from('votes')
                      .select('id, session_id, question_id, participant_id, answer, created_at')
                      .eq('question_id', String(activeQ.id))
                      .then((r) => r.data),
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200)),
                  ]);
                  if (Array.isArray(sbVotes)) {
                    const otherVotes = (db.votes || []).filter(
                      (v) => String(v.question_id) !== String(activeQ.id)
                    );
                    db.votes = [...otherVotes, ...(sbVotes as Array<Record<string, unknown>>)];
                  }
                } catch {}
              }

              const closedQId = String(activeQ.id);
              activeQ.is_open = false;
              for (const q of db.questions || []) {
                if (String(q.id) !== closedQId && Number(q.slide_number) > slideNum) {
                  q.slide_number = Number(q.slide_number) + 1;
                }
              }
              // Conserver active_question_id sur la question clôturée avec show_results=true pour afficher le résultat sur le GSM
              session.active_question_id = closedQId;
              session.show_results = true;
              const st = getStatsForQuestion(closedQId);
              const qTitle = String(activeQ.title || `Diapositive ${slideNum}`).replace(/\|/g, '-');
              const sCode = String(session.code || '38NKMQ');
              saveServerDb(db);

              res.statusCode = 200;
              res.end(
                `CLOSED_INSERT|${st.total}|${st.ouiCount}|${st.ouiPct}|${st.nonCount}|${st.nonPct}|${st.abstCount}|${st.abstPct}|${sCode}|${qTitle}`
              );

              if (sb) {
                const shiftedQuestions = (db.questions || []).filter(
                  (q) => String(q.id) !== closedQId
                );
                void (async () => {
                  try {
                    await sb.from('questions').update({ is_open: false }).eq('id', closedQId);
                    await sb
                      .from('sessions')
                      .update({ active_question_id: closedQId, show_results: true })
                      .eq('id', String(session.id));
                    for (const q of shiftedQuestions) {
                      await sb
                        .from('questions')
                        .update({ slide_number: Number(q.slide_number) })
                        .eq('id', String(q.id));
                    }
                  } catch {}
                })();
              }
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
                // Conserver le QR Code public GitHub Pages dans qr-session.png (ne pas l'écraser par une IP locale 172.x / 192.x)
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
