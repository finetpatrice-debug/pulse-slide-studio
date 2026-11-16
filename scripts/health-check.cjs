const https = require('https');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://ztjppnonfccdytvgpqrl.supabase.co';
const SUPABASE_KEY = 'sb_publishable_kaNBOm-Q29rHSWImjMnWAg_E0QB16Eu';
const PUBLIC_VOTE_URL = 'https://finetpatrice-debug.github.io/pulse-slide-studio/join/38NKMQ';
const LOG_FILE = path.resolve(__dirname, '..', 'health-check.log');

// Seuils de prévention d'activité (Plan Gratuit Supabase)
const MAX_SAFE_IMAGE_KB = 0;
const WARN_VOTES_COUNT = 12000;
const WARN_QUESTIONS_COUNT = 80;

async function auditSupabase() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: sessions, error: sErr } = await sb
    .from('sessions')
    .select('code, title, is_active')
    .eq('code', '38NKMQ');
  if (sErr) throw new Error('Supabase error: ' + sErr.message);

  const { data: questions } = await sb.from('questions').select('id, correct_option');
  const { count: votesCount } = await sb.from('votes').select('*', { count: 'exact', head: true });
  const { count: participantsCount } = await sb
    .from('participants')
    .select('*', { count: 'exact', head: true });

  let imageBytes = 0;
  for (const q of questions || []) {
    if (q.correct_option) imageBytes += String(q.correct_option).length;
  }
  const imageKB = Math.round(imageBytes / 1024);

  // Purge préventive automatique si une image base64 est détectée
  if (imageKB > MAX_SAFE_IMAGE_KB) {
    await sb
      .from('questions')
      .update({ correct_option: null })
      .neq('id', '00000000-0000-0000-0000-000000000000');
  }

  const qCount = (questions || []).length;
  const vCount = votesCount || 0;
  const pCount = participantsCount || 0;
  const estimatedDbKB = Math.round((qCount * 0.5) + (vCount * 0.25) + (pCount * 0.2));

  const alerts = [];
  if (imageKB > MAX_SAFE_IMAGE_KB) {
    alerts.push(`ALERTE BANDE PASSANTE : ${imageKB} Ko d'images détectés et purgés automatiquement`);
  }
  if (vCount >= WARN_VOTES_COUNT) {
    alerts.push(`ALERTE VOLUME VOTES : ${vCount} votes stockés (seuil préventif : ${WARN_VOTES_COUNT})`);
  }
  if (qCount >= WARN_QUESTIONS_COUNT) {
    alerts.push(`ALERTE QUESTIONS : ${qCount} questions stockées (seuil préventif : ${WARN_QUESTIONS_COUNT})`);
  }

  return {
    sessions,
    questionsCount: qCount,
    votesCount: vCount,
    participantsCount: pCount,
    imageKB,
    estimatedDbKB,
    status: alerts.length > 0 ? 'ALERTE_SURVEILLANCE' : 'NORMAL_GRATUIT',
    alerts,
  };
}

function checkGitHubPages() {
  return new Promise((resolve, reject) => {
    https
      .get(PUBLIC_VOTE_URL, (res) => {
        res.resume();
        resolve({ statusCode: res.statusCode, url: PUBLIC_VOTE_URL });
      })
      .on('error', reject);
  });
}

(async () => {
  const now = new Date().toISOString();
  try {
    const [audit, ghStatus] = await Promise.all([auditSupabase(), checkGitHubPages()]);
    const ghOk = ghStatus.statusCode === 200 || ghStatus.statusCode === 301;
    const line = `${now} | STATUT: ${audit.status} | SUPABASE: OK (${audit.questionsCount} questions, ${audit.votesCount} votes, ${audit.participantsCount} votants, ~${audit.estimatedDbKB} Ko / 500 Mo, Images=${audit.imageKB} Ko) | GITHUB_PAGES: ${ghOk ? 'OK' : 'WARN'} (HTTP ${ghStatus.statusCode})${audit.alerts.length ? ' | ALERTES: ' + audit.alerts.join(' ; ') : ''}\r\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
    console.log(line.trim());
  } catch (err) {
    const errLine = `${now} | ERROR: ${err.message}\r\n`;
    try {
      fs.appendFileSync(LOG_FILE, errLine, 'utf-8');
    } catch {}
    console.error(errLine.trim());
    process.exit(1);
  }
})();
