import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ShieldCheck,
  Lock,
  LogOut,
  Users,
  Search,
  UserPlus,
  RefreshCw,
  Unlock,
  FileSpreadsheet,
  BarChart3,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Eye,
  EyeOff,
  X,
} from 'lucide-react';
import { pollService } from '../services/pollService';
import type { Participant, Question, Session, Vote } from '../types/poll';
import { DEFAULT_REGIE_SESSION_CODE, hashCohostPin } from '../utils/cohostPin';

type RegieTab = 'participants' | 'live' | 'pv';
type ParticipantFilter = 'all' | 'connected' | 'waiting';

function getSessionStorageKey(sessionCode: string): string {
  return `pulseslide_regie_auth_v1_${sessionCode.toUpperCase()}`;
}

export default function CoHostPage() {
  const { sessionCode: rawParam } = useParams<{ sessionCode?: string }>();
  const sessionCode = (rawParam || DEFAULT_REGIE_SESSION_CODE).trim().toUpperCase();

  // État chargement & verrouillage PIN
  const [loadingInit, setLoadingInit] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [expectedPinHash, setExpectedPinHash] = useState<string | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);

  const [pinInput, setPinInput] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockedUntilMs, setLockedUntilMs] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());

  // Données Secrétariat / Régie
  const [activeTab, setActiveTab] = useState<RegieTab>('participants');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [liveVoteCount, setLiveVoteCount] = useState<number>(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdatedLabel, setLastUpdatedLabel] = useState<string>('');

  // Recherche & Filtres (100 % local en mémoire)
  const [searchQuery, setSearchQuery] = useState('');
  const [participantFilter, setParticipantFilter] = useState<ParticipantFilter>('all');

  // Ajout retardataire
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [addingVoter, setAddingVoter] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Modale de confirmation de déblocage individuel (#0000)
  const [unlockTarget, setUnlockTarget] = useState<Participant | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const lastSessionSigRef = useRef<string>('');
  const lastTitleRef = useRef<string>('');
  const lastPinCheckRef = useRef<number>(0);

  // Minuteur de décompte si temporisation anti-bruteforce active
  useEffect(() => {
    if (lockedUntilMs <= Date.now()) return;
    const t = window.setInterval(() => {
      const current = Date.now();
      setNowMs(current);
      if (current >= lockedUntilMs) {
        window.clearInterval(t);
      }
    }, 500);
    return () => window.clearInterval(t);
  }, [lockedUntilMs]);

  const showToast = useCallback((type: 'ok' | 'err', text: string) => {
    setFeedbackMsg({ type, text });
    window.setTimeout(() => {
      setFeedbackMsg((prev) => (prev?.text === text ? null : prev));
    }, 5000);
  }, []);

  // Chargement initial léger : session + hash PIN configuré
  const loadInitialGate = useCallback(async () => {
    setLoadingInit(true);
    setInitError(null);
    try {
      const [sess, pinHash] = await Promise.all([
        pollService.getSessionByCode(sessionCode),
        pollService.getCohostPinHash(sessionCode),
      ]);

      if (!sess) {
        setInitError(`Séance « ${sessionCode} » introuvable.`);
        setSession(null);
        setExpectedPinHash(null);
        setIsUnlocked(false);
        return;
      }

      setSession(sess);
      setExpectedPinHash(pinHash);

      if (pinHash) {
        const storedHash = sessionStorage.getItem(getSessionStorageKey(sessionCode));
        if (storedHash && storedHash === pinHash) {
          setIsUnlocked(true);
        } else {
          sessionStorage.removeItem(getSessionStorageKey(sessionCode));
          setIsUnlocked(false);
        }
      } else {
        sessionStorage.removeItem(getSessionStorageKey(sessionCode));
        setIsUnlocked(false);
      }
    } catch (err) {
      setInitError(err instanceof Error ? err.message : 'Erreur de connexion à la base de données.');
    } finally {
      setLoadingInit(false);
    }
  }, [sessionCode]);

  useEffect(() => {
    void loadInitialGate();
  }, [loadInitialGate]);

  // Chargement complet à la demande (ouverture, actualisation manuelle)
  const refreshAllData = useCallback(
    async (silent = false) => {
      if (!session) return;
      if (!silent) setIsRefreshing(true);
      try {
        const [freshSession, freshParticipants, freshQuestions, freshVotes] = await Promise.all([
          pollService.getSessionLightweightState(session.id),
          pollService.getParticipantsBySession(session.id),
          pollService.getQuestionsBySession(session.id),
          pollService.getVotesBySession(session.id),
        ]);

        const activeSess = freshSession || session;
        setSession(activeSess);
        setParticipants(freshParticipants);
        setQuestions(freshQuestions);
        setVotes(freshVotes);

        const activeQ = activeSess.active_question_id
          ? freshQuestions.find((q) => q.id === activeSess.active_question_id)
          : null;
        if (activeQ) {
          const count = freshVotes.filter((v) => v.question_id === activeQ.id).length;
          setLiveVoteCount(count);
        } else {
          setLiveVoteCount(0);
        }

        lastSessionSigRef.current = `${activeSess.title}|${activeSess.active_question_id || ''}|${Boolean(
          activeSess.show_results
        )}|${activeSess.current_slide}`;
        lastTitleRef.current = activeSess.title;
        setLastUpdatedLabel(
          new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        );
      } catch (err) {
        if (!silent) {
          showToast(
            'err',
            err instanceof Error ? err.message : 'Impossible de rafraîchir les données.'
          );
        }
      } finally {
        if (!silent) setIsRefreshing(false);
      }
    },
    [session, showToast]
  );

  // Dès le déverrouillage, charger une fois toutes les données de la séance
  const hasLoadedOnceRef = useRef(false);
  useEffect(() => {
    if (isUnlocked && session && !hasLoadedOnceRef.current) {
      hasLoadedOnceRef.current = true;
      void refreshAllData(false);
    }
    if (!isUnlocked) {
      hasLoadedOnceRef.current = false;
    }
  }, [isUnlocked, session, refreshAllData]);

  // Question active courante (hors preview)
  const realQuestions = useMemo(
    () => questions.filter((q) => q.title !== '__SLIDE_PREVIEW__'),
    [questions]
  );

  const activeQuestion = useMemo(() => {
    if (!session?.active_question_id) return null;
    return realQuestions.find((q) => q.id === session.active_question_id) ?? null;
  }, [realQuestions, session?.active_question_id]);

  // Surveillance ultra-légère toutes les 3 secondes (conforme forfait gratuit Supabase : ~200 o/requête)
  useEffect(() => {
    if (!isUnlocked || !session) return;

    let cancelled = false;
    const sessionId = session.id;
    const currentCode = session.code;

    const tick = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      try {
        // 1. Vérifier si le PIN a été modifié ou désactivé toutes les 15 secondes
        const now = Date.now();
        if (now - lastPinCheckRef.current >= 15000) {
          lastPinCheckRef.current = now;
          const latestHash = await pollService.getCohostPinHash(currentCode);
          if (cancelled) return;
          const stored = sessionStorage.getItem(getSessionStorageKey(currentCode));
          if (!latestHash || latestHash !== stored) {
            setExpectedPinHash(latestHash);
            sessionStorage.removeItem(getSessionStorageKey(currentCode));
            setIsUnlocked(false);
            setPinError(
              latestHash
                ? 'Le PIN Régie a été modifié par l’animateur principal. Veuillez saisir le nouveau PIN.'
                : 'L’accès Régie a été désactivé par l’animateur principal.'
            );
            return;
          }
        }

        // 2. Micro-requête d'état sur sessions (~150 octets)
        const lightSess = await pollService.getSessionLightweightState(sessionId);
        if (cancelled || !lightSess) return;

        const nextSig = `${lightSess.title}|${lightSess.active_question_id || ''}|${Boolean(
          lightSess.show_results
        )}|${lightSess.current_slide}`;

        if (nextSig !== lastSessionSigRef.current) {
          const titleChanged = lastTitleRef.current !== '' && lightSess.title !== lastTitleRef.current;
          lastSessionSigRef.current = nextSig;
          lastTitleRef.current = lightSess.title;
          setSession(lightSess);

          const freshQ = await pollService.getQuestionsBySession(sessionId);
          if (cancelled) return;
          setQuestions(freshQ);

          if (lightSess.show_results) {
            const freshV = await pollService.getVotesBySession(sessionId);
            if (cancelled) return;
            setVotes(freshV);
            if (lightSess.active_question_id) {
              setLiveVoteCount(
                freshV.filter((v) => v.question_id === lightSess.active_question_id).length
              );
            }
          } else if (lightSess.active_question_id) {
            const cnt = await pollService.getQuestionVoteCountHead(lightSess.active_question_id);
            if (!cancelled) setLiveVoteCount(cnt);
          } else {
            setLiveVoteCount(0);
          }

          if (titleChanged) {
            const freshP = await pollService.getParticipantsBySession(sessionId);
            if (!cancelled) setParticipants(freshP);
          }

          setLastUpdatedLabel(
            new Date().toLocaleTimeString('fr-FR', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })
          );
          return;
        }

        // 3. Si un scrutin est OUVERT, comptage HEAD ultra-léger (~300 octets) uniquement
        if (lightSess.active_question_id && !lightSess.show_results) {
          const cnt = await pollService.getQuestionVoteCountHead(lightSess.active_question_id);
          if (!cancelled) {
            setLiveVoteCount(cnt);
          }
        }
      } catch {
        // Ignorer erreurs réseau ponctuelles
      }
    };

    const timer = window.setInterval(() => {
      void tick();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isUnlocked, session?.id, session?.code]);

  // Validation du PIN
  const handleUnlockSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!expectedPinHash) return;

    const current = Date.now();
    if (lockedUntilMs > current) {
      const remSec = Math.ceil((lockedUntilMs - current) / 1000);
      setPinError(`Trop de tentatives. Patientez ${remSec} seconde(s).`);
      return;
    }

    const cleanPin = pinInput.trim();
    if (!cleanPin) {
      setPinError('Veuillez saisir le code PIN Régie.');
      return;
    }

    const candidateHash = hashCohostPin(sessionCode, cleanPin);
    if (candidateHash === expectedPinHash) {
      sessionStorage.setItem(getSessionStorageKey(sessionCode), candidateHash);
      setPinInput('');
      setPinError(null);
      setFailedAttempts(0);
      setLockedUntilMs(0);
      lastPinCheckRef.current = Date.now();
      setIsUnlocked(true);
    } else {
      const nextFails = failedAttempts + 1;
      setFailedAttempts(nextFails);
      if (nextFails >= 5) {
        const penaltyMs = Math.min(60000, (nextFails - 4) * 15000);
        setLockedUntilMs(Date.now() + penaltyMs);
        setPinError(`PIN incorrect. Accès temporairement bloqué (${penaltyMs / 1000}s).`);
      } else {
        setPinError(`Code PIN incorrect (${nextFails}/5).`);
      }
    }
  };

  const handleLock = () => {
    sessionStorage.removeItem(getSessionStorageKey(sessionCode));
    setIsUnlocked(false);
    setPinInput('');
    setPinError(null);
  };

  // Ajout retardataire
  const handleAddVoter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setAddingVoter(true);
    try {
      const created = await pollService.addParticipantFromRegie(session.id, newEmail, newName);
      setParticipants((prev) => [...prev, created]);
      setNewEmail('');
      setNewName('');
      const baseName = pollService.extractParticipantBaseName(created.nickname);
      const email = pollService.extractParticipantEmail(created.nickname);
      showToast('ok', `Votant ajouté : ${baseName} (${email}). Il peut se connecter immédiatement.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : "Impossible d'ajouter ce votant.");
    } finally {
      setAddingVoter(false);
    }
  };

  // Déblocage individuel (#0000) confirmé
  const confirmUnlockSingleParticipant = async () => {
    if (!unlockTarget) return;
    setUnlocking(true);
    try {
      const updated = await pollService.unlockSingleParticipantPin(unlockTarget);
      setParticipants((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      const baseName = pollService.extractParticipantBaseName(updated.nickname);
      const email = pollService.extractParticipantEmail(updated.nickname);
      showToast(
        'ok',
        `Code réinitialisé (#0000) pour ${baseName} (${email}). Il peut se reconnecter sur son nouveau téléphone.`
      );
      setUnlockTarget(null);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Erreur lors du déblocage.');
    } finally {
      setUnlocking(false);
    }
  };

  // Préparation de la liste des participants avec recherche 100 % locale
  const parsedParticipants = useMemo(() => {
    return participants.map((p, index) => {
      const email = pollService.extractParticipantEmail(p.nickname);
      const name = pollService.extractParticipantBaseName(p.nickname) || email || p.nickname;
      const pin = pollService.extractParticipantPin(p);
      const isConnected = pin !== '0000';
      return {
        raw: p,
        index: index + 1,
        name,
        email,
        pin,
        isConnected,
      };
    });
  }, [participants]);

  const connectedCount = useMemo(
    () => parsedParticipants.filter((p) => p.isConnected).length,
    [parsedParticipants]
  );
  const waitingCount = parsedParticipants.length - connectedCount;

  const filteredParticipants = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return parsedParticipants.filter((p) => {
      if (participantFilter === 'connected' && !p.isConnected) return false;
      if (participantFilter === 'waiting' && p.isConnected) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        p.pin.includes(q.replace(/^#/, '')) ||
        `#${p.pin}`.includes(q)
      );
    });
  }, [parsedParticipants, participantFilter, searchQuery]);

  // Calculs résultats d'une question donnée
  const computeQuestionStats = useCallback(
    (questionId: string) => {
      const qVotes = votes.filter((v) => v.question_id === questionId);
      let oui = 0;
      let non = 0;
      let abst = 0;
      for (const v of qVotes) {
        const ans = String(v.answer || '').trim().toUpperCase();
        if (ans === 'OUI') oui++;
        else if (ans === 'NON') non++;
        else abst++;
      }
      const total = qVotes.length;
      const ouiPct = total > 0 ? Math.round((oui / total) * 100) : 0;
      const nonPct = total > 0 ? Math.round((non / total) * 100) : 0;
      const abstPct = total > 0 ? Math.round((abst / total) * 100) : 0;
      let verdict: 'ADOPTÉE' | 'REJETÉE' | 'ÉGALITÉ' | 'SANS VOTE' = 'SANS VOTE';
      if (total > 0) {
        if (oui > non) verdict = 'ADOPTÉE';
        else if (non > oui) verdict = 'REJETÉE';
        else verdict = 'ÉGALITÉ';
      }
      return { total, oui, non, abst, ouiPct, nonPct, abstPct, verdict };
    },
    [votes]
  );

  // ============================================================================
  // RENDU — ÉCRAN DE CHARGEMENT / ERREUR / VERROUILLAGE PIN
  // ============================================================================
  if (loadingInit) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3 text-slate-300">
          <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
          <p className="text-sm font-medium">Connexion à l’espace Secrétariat / Régie…</p>
        </div>
      </div>
    );
  }

  if (initError || !session) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center space-y-4">
          <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto" />
          <h1 className="text-xl font-bold">Accès Régie indisponible</h1>
          <p className="text-sm text-slate-400">{initError || 'Séance introuvable.'}</p>
          <button
            onClick={() => void loadInitialGate()}
            className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold transition"
          >
            Réessayer
          </button>
        </div>
      </div>
    );
  }

  if (!isUnlocked) {
    const remainingBlockSec = Math.max(0, Math.ceil((lockedUntilMs - nowMs) / 1000));
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-slate-900/95 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center mx-auto">
              <ShieldCheck className="w-7 h-7 text-indigo-400" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Secrétariat & Régie</h1>
            <p className="text-sm text-slate-400">
              Co-animation en direct — Séance <span className="font-mono text-indigo-300">{session.code}</span>
            </p>
          </div>

          {!expectedPinHash ? (
            <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-4 text-sm text-amber-200 space-y-2">
              <p className="font-semibold flex items-center gap-2">
                <Lock className="w-4 h-4 shrink-0" />
                Accès Régie non activé pour cette séance
              </p>
              <p className="text-amber-200/80 text-xs leading-relaxed">
                Aucun PIN Co-animateur n’a encore été défini. L’animateur principal doit ouvrir
                PowerPoint → onglet <strong>Vote en Direct</strong> → bouton{' '}
                <strong>Accès Régie (QR &amp; PIN)</strong> pour choisir un code PIN.
              </p>
              <button
                type="button"
                onClick={() => void loadInitialGate()}
                className="mt-2 w-full py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 font-semibold text-xs transition"
              >
                Vérifier à nouveau
              </button>
            </div>
          ) : (
            <form onSubmit={handleUnlockSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  Code PIN Co-animateur
                </label>
                <div className="relative">
                  <input
                    type={showPin ? 'text' : 'password'}
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value)}
                    placeholder="Saisissez le PIN choisi pour cette AG"
                    autoFocus
                    disabled={remainingBlockSec > 0}
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 focus:border-indigo-500 focus:outline-none px-4 py-3.5 pr-12 text-base font-mono tracking-widest text-white placeholder:tracking-normal placeholder:font-sans placeholder:text-slate-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 p-1"
                    aria-label="Afficher ou masquer le PIN"
                  >
                    {showPin ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              {pinError && (
                <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 px-3.5 py-2.5 text-xs text-rose-300">
                  {pinError}
                </div>
              )}

              <button
                type="submit"
                disabled={remainingBlockSec > 0}
                className="w-full py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold text-sm transition flex items-center justify-center gap-2"
              >
                <Lock className="w-4 h-4" />
                {remainingBlockSec > 0
                  ? `Patientez ${remainingBlockSec}s…`
                  : 'Accéder à la Régie'}
              </button>

              <p className="text-[11px] text-center text-slate-500 leading-relaxed">
                Accès réservé au Secrétariat / Régie : recherche des codes, ajout de retardataires,
                déblocage individuel (#0000), suivi en direct et export PV CSV.
              </p>
            </form>
          )}
        </div>
      </div>
    );
  }

  // ============================================================================
  // RENDU — TABLEAU DE BORD SECRÉTARIAT / RÉGIE DÉVERROUILLÉ
  // ============================================================================
  const activeStats = activeQuestion ? computeQuestionStats(activeQuestion.id) : null;
  const isVoteOpen = Boolean(activeQuestion && activeQuestion.is_open && !session.show_results);
  const isShowingResults = Boolean(activeQuestion && session.show_results);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 pb-12">
      {/* Barre supérieure */}
      <header className="sticky top-0 z-30 bg-slate-900/95 backdrop-blur border-b border-slate-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5 text-indigo-400" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="font-bold text-base sm:text-lg truncate">Secrétariat &amp; Régie</h1>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-300">
                  Séance {session.code}
                </span>
              </div>
              <p className="text-xs text-slate-400 truncate">
                {session.title}
                {lastUpdatedLabel ? ` • Màj ${lastUpdatedLabel}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshAllData(false)}
              disabled={isRefreshing}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs sm:text-sm font-medium flex items-center gap-2 transition"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-indigo-400' : ''}`} />
              Actualiser
            </button>
            <button
              type="button"
              onClick={handleLock}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-rose-950/60 border border-slate-700 hover:border-rose-500/40 text-slate-300 hover:text-rose-200 text-xs sm:text-sm font-medium flex items-center gap-2 transition"
            >
              <LogOut className="w-4 h-4" />
              Verrouiller
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 pt-5 space-y-5">
        {/* Bandeau d'état du scrutin en direct (lecture seule) */}
        <section
          className={`rounded-2xl border p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
            isVoteOpen
              ? 'bg-emerald-950/35 border-emerald-500/40'
              : isShowingResults
              ? 'bg-indigo-950/35 border-indigo-500/40'
              : 'bg-slate-900 border-slate-800'
          }`}
        >
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {isVoteOpen ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  SCRUTIN OUVERT EN DIRECT
                </span>
              ) : isShowingResults ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  SCRUTIN CLÔTURÉ — RÉSULTATS AFFICHÉS
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700">
                  <Clock className="w-3.5 h-3.5" />
                  EN ATTENTE DU PROCHAIN VOTE
                </span>
              )}
              <span className="text-xs text-slate-400">Diapositive {session.current_slide}</span>
            </div>
            <p className="text-sm sm:text-base font-semibold text-white truncate">
              {activeQuestion
                ? activeQuestion.title
                : 'Aucun scrutin ouvert — le pilotage reste sur le PC PowerPoint.'}
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="px-4 py-2 rounded-xl bg-slate-950/70 border border-slate-800 text-center min-w-[110px]">
              <div className="text-2xl font-extrabold text-white leading-none">{liveVoteCount}</div>
              <div className="text-[11px] text-slate-400 mt-1">Vote(s) reçu(s)</div>
            </div>
            <div className="px-4 py-2 rounded-xl bg-slate-950/70 border border-slate-800 text-center min-w-[110px]">
              <div className="text-2xl font-extrabold text-emerald-400 leading-none">
                {connectedCount}
                <span className="text-sm font-medium text-slate-500">/{parsedParticipants.length}</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">Connectés</div>
            </div>
          </div>
        </section>

        {/* Notifications */}
        {feedbackMsg && (
          <div
            className={`rounded-xl px-4 py-3 text-sm font-medium flex items-center justify-between gap-3 border ${
              feedbackMsg.type === 'ok'
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                : 'bg-rose-500/15 border-rose-500/40 text-rose-200'
            }`}
          >
            <span>{feedbackMsg.text}</span>
            <button onClick={() => setFeedbackMsg(null)} className="opacity-70 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Onglets de navigation */}
        <nav className="grid grid-cols-3 gap-2 bg-slate-900 p-1.5 rounded-2xl border border-slate-800">
          <button
            type="button"
            onClick={() => setActiveTab('participants')}
            className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-semibold flex items-center justify-center gap-2 transition ${
              activeTab === 'participants'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/70'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>Inscrits &amp; Codes ({parsedParticipants.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('live')}
            className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-semibold flex items-center justify-center gap-2 transition ${
              activeTab === 'live'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/70'
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            <span>Suivi Scrutin</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('pv');
              void refreshAllData(true);
            }}
            className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-semibold flex items-center justify-center gap-2 transition ${
              activeTab === 'pv'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/70'
            }`}
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span>PV &amp; Export CSV ({realQuestions.length})</span>
          </button>
        </nav>

        {/* ====================================================================
            ONGLET 1 : INSCRITS, CODES #XXXX, RETARDATAIRE, DÉBLOCAGE #0000
           ==================================================================== */}
        {activeTab === 'participants' && (
          <div className="space-y-5">
            {/* Formulaire ajout retardataire */}
            <form
              onSubmit={handleAddVoter}
              className="rounded-2xl bg-slate-900 border border-slate-800 p-4 sm:p-5 space-y-3"
            >
              <div className="flex items-center gap-2 text-sm font-bold text-white">
                <UserPlus className="w-4 h-4 text-emerald-400" />
                <span>Ajouter un participant en dernière minute (retardataire)</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="Adresse e-mail officielle (ex: prenom.nom@domaine.be)"
                  className="sm:col-span-5 rounded-xl bg-slate-950 border border-slate-700 focus:border-emerald-500 focus:outline-none px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500"
                />
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Nom Prénom (optionnel)"
                  className="sm:col-span-4 rounded-xl bg-slate-950 border border-slate-700 focus:border-emerald-500 focus:outline-none px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500"
                />
                <button
                  type="submit"
                  disabled={addingVoter}
                  className="sm:col-span-3 py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold transition flex items-center justify-center gap-2"
                >
                  <UserPlus className="w-4 h-4" />
                  {addingVoter ? 'Ajout…' : 'Autoriser'}
                </button>
              </div>
            </form>

            {/* Recherche 100 % locale + Filtres */}
            <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden">
              <div className="p-4 border-b border-slate-800 space-y-3">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Rechercher un nom, un e-mail ou un code (#XXXX)…"
                      className="w-full rounded-xl bg-slate-950 border border-slate-700 focus:border-indigo-500 focus:outline-none pl-10 pr-9 py-2.5 text-sm text-white placeholder:text-slate-500"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800">
                    <button
                      type="button"
                      onClick={() => setParticipantFilter('all')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                        participantFilter === 'all'
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Tous ({parsedParticipants.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setParticipantFilter('connected')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                        participantFilter === 'connected'
                          ? 'bg-emerald-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Connectés ({connectedCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setParticipantFilter('waiting')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                        participantFilter === 'waiting'
                          ? 'bg-slate-700 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      En attente ({waitingCount})
                    </button>
                  </div>
                </div>
              </div>

              {/* Tableau / Liste responsive */}
              <div className="divide-y divide-slate-800/80 max-h-[58vh] overflow-y-auto">
                {filteredParticipants.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-400">
                    Aucun inscrit ne correspond à votre filtre.
                  </div>
                ) : (
                  filteredParticipants.map((p) => (
                    <div
                      key={p.raw.id}
                      className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 hover:bg-slate-800/40 transition"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-slate-500 w-7 shrink-0">
                            {p.index}.
                          </span>
                          <span className="font-semibold text-sm text-white truncate">
                            {p.name}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 pl-9 truncate">{p.email}</div>
                      </div>

                      <div className="flex items-center justify-between sm:justify-end gap-2.5 pl-9 sm:pl-0 shrink-0">
                        {p.isConnected ? (
                          <>
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 font-mono font-bold text-xs">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              #{p.pin}
                            </span>
                            <button
                              type="button"
                              onClick={() => setUnlockTarget(p.raw)}
                              title="Remettre le code de ce votant à #0000 (changement de téléphone)"
                              className="px-2.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-200 text-xs font-semibold flex items-center gap-1.5 transition"
                            >
                              <Unlock className="w-3.5 h-3.5" />
                              Débloquer
                            </button>
                          </>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 text-xs">
                            <Clock className="w-3.5 h-3.5" />
                            En attente de 1re connexion
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ====================================================================
            ONGLET 2 : SUIVI EN DIRECT DU SCRUTIN (LECTURE SEULE)
           ==================================================================== */}
        {activeTab === 'live' && (
          <div className="rounded-2xl bg-slate-900 border border-slate-800 p-5 sm:p-6 space-y-5">
            {!activeQuestion ? (
              <div className="py-10 text-center space-y-2 text-slate-400">
                <Clock className="w-10 h-10 mx-auto text-slate-600" />
                <p className="font-semibold text-slate-200">Aucun scrutin actif pour le moment</p>
                <p className="text-xs">
                  Dès que l’animateur principal ouvrira un vote sur PowerPoint, le compteur en direct
                  apparaîtra automatiquement ici.
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wider font-semibold text-indigo-400">
                    Diapositive {activeQuestion.slide_number ?? session.current_slide} — Lecture seule
                  </p>
                  <h2 className="text-xl font-bold text-white">{activeQuestion.title}</h2>
                </div>

                {isVoteOpen ? (
                  <div className="rounded-2xl bg-emerald-950/30 border border-emerald-500/35 p-6 text-center space-y-2">
                    <div className="text-5xl font-black text-emerald-400">{liveVoteCount}</div>
                    <p className="text-sm text-emerald-200 font-medium">
                      vote(s) enregistré(s) sur {connectedCount} participant(s) connecté(s)
                    </p>
                    <p className="text-xs text-slate-400 pt-1">
                      Les résultats détaillés (OUI / NON / ABSTENTION) s’afficheront automatiquement dès
                      que l’animateur clôturera le scrutin sur PowerPoint.
                    </p>
                  </div>
                ) : activeStats ? (
                  <div className="space-y-4">
                    <div
                      className={`rounded-xl px-4 py-3 font-bold text-center text-base ${
                        activeStats.verdict === 'ADOPTÉE'
                          ? 'bg-emerald-600 text-white'
                          : activeStats.verdict === 'REJETÉE'
                          ? 'bg-rose-600 text-white'
                          : 'bg-amber-600 text-white'
                      }`}
                    >
                      {activeStats.verdict === 'ADOPTÉE'
                        ? `PROPOSITION ADOPTÉE — OUI : ${activeStats.ouiPct} %`
                        : activeStats.verdict === 'REJETÉE'
                        ? `PROPOSITION REJETÉE — NON : ${activeStats.nonPct} %`
                        : activeStats.verdict === 'ÉGALITÉ'
                        ? `ÉGALITÉ DES VOIX — OUI : ${activeStats.ouiPct} % | NON : ${activeStats.nonPct} %`
                        : 'AUCUN VOTE EXPRIMÉ'}
                    </div>

                    {[
                      {
                        label: 'OUI',
                        count: activeStats.oui,
                        pct: activeStats.ouiPct,
                        bar: 'bg-emerald-500',
                      },
                      {
                        label: 'NON',
                        count: activeStats.non,
                        pct: activeStats.nonPct,
                        bar: 'bg-rose-500',
                      },
                      {
                        label: 'ABSTENTION',
                        count: activeStats.abst,
                        pct: activeStats.abstPct,
                        bar: 'bg-sky-500',
                      },
                    ].map((row) => (
                      <div key={row.label} className="space-y-1.5">
                        <div className="flex justify-between text-sm font-semibold">
                          <span>{row.label}</span>
                          <span>
                            {row.count} voix ({row.pct} %)
                          </span>
                        </div>
                        <div className="h-4 rounded-full bg-slate-800 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${row.bar} transition-all duration-300`}
                            style={{ width: `${Math.max(row.pct, row.count > 0 ? 4 : 0)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}

        {/* ====================================================================
            ONGLET 3 : PROCÈS-VERBAL & EXPORT CSV
           ==================================================================== */}
        {activeTab === 'pv' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-white">
                  Procès-Verbal des résolutions ({realQuestions.length})
                </h2>
                <p className="text-xs text-slate-400">
                  Total des bulletins enregistrés sur la séance : {votes.length}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => pollService.exportRegieSummaryPvCsv(session, realQuestions, votes)}
                  className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs sm:text-sm font-semibold flex items-center gap-2 transition"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  Exporter PV Synthèse (CSV)
                </button>
                <button
                  type="button"
                  onClick={() =>
                    pollService.exportSessionResultsToCsv(
                      session,
                      realQuestions,
                      participants,
                      votes
                    )
                  }
                  className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs sm:text-sm font-semibold flex items-center gap-2 transition"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  Exporter Détail Votes (CSV)
                </button>
              </div>
            </div>

            <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-x-auto">
              {realQuestions.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-400">
                  Aucun scrutin enregistré pour le moment.
                </div>
              ) : (
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead className="bg-slate-950/80 text-slate-400 uppercase text-[11px]">
                    <tr>
                      <th className="px-4 py-3">Slide</th>
                      <th className="px-4 py-3">Proposition</th>
                      <th className="px-3 py-3 text-right">OUI</th>
                      <th className="px-3 py-3 text-right">NON</th>
                      <th className="px-3 py-3 text-right">ABST</th>
                      <th className="px-3 py-3 text-right">Total</th>
                      <th className="px-4 py-3 text-right">Verdict</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {realQuestions.map((q) => {
                      const st = computeQuestionStats(q.id);
                      return (
                        <tr key={q.id} className="hover:bg-slate-800/40">
                          <td className="px-4 py-3 font-mono text-slate-400">
                            {q.slide_number ?? '-'}
                          </td>
                          <td className="px-4 py-3 font-medium text-white max-w-md">
                            {q.title}
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-emerald-300">
                            {st.oui} ({st.ouiPct}%)
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-rose-300">
                            {st.non} ({st.nonPct}%)
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-sky-300">
                            {st.abst} ({st.abstPct}%)
                          </td>
                          <td className="px-3 py-3 text-right font-mono font-bold text-white">
                            {st.total}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span
                              className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                                st.verdict === 'ADOPTÉE'
                                  ? 'bg-emerald-500/20 text-emerald-300'
                                  : st.verdict === 'REJETÉE'
                                  ? 'bg-rose-500/20 text-rose-300'
                                  : st.verdict === 'ÉGALITÉ'
                                  ? 'bg-amber-500/20 text-amber-300'
                                  : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              {q.is_open ? 'EN COURS' : st.verdict}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Modale de confirmation nominative pour le déblocage individuel (#0000) */}
      {unlockTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full rounded-2xl bg-slate-900 border border-slate-700 p-6 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/35 flex items-center justify-center shrink-0">
                <Unlock className="w-5 h-5 text-amber-400" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-white">
                  Débloquer uniquement ce votant ?
                </h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  <strong>{pollService.extractParticipantBaseName(unlockTarget.nickname)}</strong>
                  <br />
                  <span className="font-mono text-indigo-300">
                    {pollService.extractParticipantEmail(unlockTarget.nickname)}
                  </span>
                </p>
              </div>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed bg-slate-950/70 rounded-xl p-3 border border-slate-800">
              Son code personnel repassera à <strong className="text-amber-300">#0000</strong> afin
              qu’il puisse se reconnecter sur un autre téléphone avec son adresse e-mail. Ses votes
              déjà exprimés sont intégralement conservés et aucun autre participant n’est affecté.
            </p>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={unlocking}
                onClick={() => setUnlockTarget(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition"
              >
                Annuler
              </button>
              <button
                type="button"
                disabled={unlocking}
                onClick={() => void confirmUnlockSingleParticipant()}
                className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition"
              >
                {unlocking ? 'Déblocage…' : 'Confirmer le déblocage (#0000)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
