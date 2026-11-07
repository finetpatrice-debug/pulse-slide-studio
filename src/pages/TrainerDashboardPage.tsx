import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { QRCodeSVG, QRCodeCanvas } from 'qrcode.react';
import {
  QrCode,
  Vote as VoteIcon,
  Download,
  CheckCircle2,
  XCircle,
  MinusCircle,
  ChevronLeft,
  ChevronRight,
  MonitorPlay,
  FileSpreadsheet,
  Trash2,
  Users,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Copy,
  Check,
  ExternalLink,
  Play,
  FilePlus2,
  Minimize2,
  RefreshCw,
} from 'lucide-react';
import { pollService } from '../services/pollService';
import { getNetworkBaseUrl } from '../lib/supabase';
import { usePresentation } from '../context/PresentationContext';
import type {
  Session,
  Question,
  Participant,
  Vote,
  PowerPointStatus,
} from '../types/poll';

type ActiveTab = 'trigger' | 'qr' | 'vote' | 'history';

export default function TrainerDashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { totalSlides, setTotalSlides } = usePresentation();

  // Onglet affiché :
  // - 'trigger' : Bouton compact en bas à droite du slide ("▶ Déclencher le vote sur ce slide")
  // - 'qr' : QR Code de connexion
  // - 'vote' : Scrutin en direct & Clôture avec insertion de diapo de résultat
  // - 'history' : Procès-Verbal & Export CSV
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    const params = new URLSearchParams(window.location.search);
    const act = params.get('pptAction');
    if (act === 'history') return 'history';
    if (act === 'qr') return 'qr';
    if (act === 'vote') return 'vote';
    return 'trigger';
  });
  const [copiedLink, setCopiedLink] = useState(false);
  const [insertingSlide, setInsertingSlide] = useState(false);
  const [resultSlideMessage, setResultSlideMessage] = useState<string | null>(null);
  const [qrSyncedMessage, setQrSyncedMessage] = useState<string | null>(null);
  const [votingSlideNumber, setVotingSlideNumber] = useState<number | null>(null);
  const [slideButtonClickSeq, setSlideButtonClickSeq] = useState<number>(0);

  // État Microsoft PowerPoint en temps réel
  const [pptStatus, setPptStatus] = useState<PowerPointStatus>({
    connected: false,
    inSlideShow: false,
    presentationName: null,
    currentSlide: 1,
    totalSlides: 10,
    slideTitle: '',
    slideText: '',
    isVoteSlide: false,
    propositionSlide: 1,
    propositionTitle: '',
  });
  const lastSyncedPptSlideRef = useRef<number>(1);
  const hasAutoSyncedQrRef = useRef<boolean>(false);

  // Données de la séance active
  const [session, setSession] = useState<Session | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [votes, setVotes] = useState<Vote[]>([]);

  // Ajuster la taille/position de la fenêtre Electron selon l'onglet actif
  const switchTabWithWindowMode = useCallback((tab: ActiveTab) => {
    setActiveTab(tab);
    if (window.powerpointBridge?.setWindowMode) {
      if (tab === 'trigger') {
        void window.powerpointBridge.setWindowMode('trigger');
      } else if (tab === 'vote') {
        void window.powerpointBridge.setWindowMode('panel');
      } else {
        void window.powerpointBridge.setWindowMode('modal');
      }
    }
  }, []);

  // 1. Synchronisation permanente avec Microsoft PowerPoint (toutes les 450ms)
  useEffect(() => {
    if (!window.powerpointBridge) return;

    let active = true;
    const syncPowerPoint = async () => {
      try {
        const st = await window.powerpointBridge!.getStatus();
        if (!active || !st) return;
        setPptStatus(st);

        if (st.slideButtonClicked) {
          setSlideButtonClickSeq((n) => n + 1);
        }

        if (st.connected && st.totalSlides >= 1) {
          setTotalSlides(st.totalSlides);
        }

        if (
          st.connected &&
          st.currentSlide >= 1 &&
          st.currentSlide !== lastSyncedPptSlideRef.current
        ) {
          lastSyncedPptSlideRef.current = st.currentSlide;
          setResultSlideMessage(null);
          setSession((prev) => {
            if (!prev || prev.current_slide === st.currentSlide) return prev;
            void pollService.updateSessionState(prev.id, {
              current_slide: st.currentSlide,
            });
            return { ...prev, current_slide: st.currentSlide };
          });
        }
      } catch {}
    };

    void syncPowerPoint();
    const timer = setInterval(syncPowerPoint, 450);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [setTotalSlides]);

  // 2. Création / Chargement automatique de la séance de vote au démarrage
  useEffect(() => {
    async function initAutomaticSession() {
      try {
        const codeFromUrl = searchParams.get('session');
        if (codeFromUrl) {
          const found = await pollService.getSessionByCode(codeFromUrl);
          if (found) {
            await loadSessionDetails(found);
            return;
          }
        }

        const recent = await pollService.listRecentSessions(1);
        if (recent.length > 0) {
          await loadSessionDetails(recent[0]);
          return;
        }

        const created = await pollService.createSession('Séance de Vote PowerPoint');
        await loadSessionDetails(created);
      } catch (err) {
        console.error(err);
      }
    }

    void initAutomaticSession();
  }, []);

  const loadSessionDetails = async (target: Session) => {
    setSession(target);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('session', target.code);
      return next;
    });
    const [qList, pList, vList] = await Promise.all([
      pollService.getQuestionsBySession(target.id),
      pollService.getParticipantsBySession(target.id),
      pollService.getVotesBySession(target.id),
    ]);
    setQuestions(qList);
    setParticipants(pList);
    setVotes(vList);
  };

  const currentSlide = pptStatus.connected
    ? pptStatus.currentSlide
    : session?.current_slide ?? 1;

  const joinUrl = session ? `${getNetworkBaseUrl()}/join/${session.code}` : '';

  // Synchroniser l'image PNG du QR Code avec PowerPoint (remplace automatiquement ClassPoint par "Vote en Direct")
  const handleSyncQrToPowerPoint = useCallback(async (showFeedback = false) => {
    try {
      const canvas = document.getElementById('ppt-export-qr-canvas') as HTMLCanvasElement | null;
      if (!canvas) return;
      const dataUrl = canvas.toDataURL('image/png');

      await fetch('/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'SAVE_QR_PNG', dataUrl }),
      });

      if (window.powerpointBridge?.syncQrSlides) {
        const st = await window.powerpointBridge.syncQrSlides(dataUrl);
        if (st) setPptStatus(st);
      }

      if (showFeedback) {
        setQrSyncedMessage('QR Code "Vote en Direct" mis à jour sur vos slides PowerPoint !');
        setTimeout(() => setQrSyncedMessage(null), 4000);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!session || !joinUrl || hasAutoSyncedQrRef.current) return;
    const t = setTimeout(() => {
      hasAutoSyncedQrRef.current = true;
      void handleSyncQrToPowerPoint(false);
    }, 600);
    return () => clearTimeout(t);
  }, [session, joinUrl, handleSyncQrToPowerPoint]);

  // Lancer un vote OUI / NON / ABSTENTION sur le slide PowerPoint actuel
  const handleLaunchResolutionVote = useCallback(
    async (keepCompactBar = false) => {
      if (!session) return;
      setResultSlideMessage(null);
      setVotingSlideNumber(currentSlide);
      if (!keepCompactBar) {
        switchTabWithWindowMode('trigger');
      }

      const displaySlideForGsm = currentSlide;

      const label =
        pptStatus.slideTitle ||
        pptStatus.slideText ||
        `Proposition soumise au vote — Slide n°${currentSlide}`;

      try {
        const { session: updatedSession } = await pollService.launchResolutionVote(
          session.id,
          displaySlideForGsm,
          label
        );
        setSession(updatedSession);
        const qList = await pollService.getQuestionsBySession(session.id);
        setQuestions(qList);

        if (window.powerpointBridge?.updateSlideButton) {
          void window.powerpointBridge.updateSlideButton({
            slideNumber: currentSlide,
            isOpen: true,
            voteCount: 0,
            ouiCount: 0,
            nonCount: 0,
            abstCount: 0,
          });
        }
      } catch (err) {
        console.error(err);
      }
    },
    [session, switchTabWithWindowMode, pptStatus, currentSlide]
  );

  // 3. Réception des clics depuis le Ruban natif de PowerPoint (onglet "Vote en Direct")
  const lastHandledTickRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session) return;
    const action = searchParams.get('pptAction');
    const tick = searchParams.get('t') || action;
    if (!action || !tick || lastHandledTickRef.current === tick) return;
    lastHandledTickRef.current = tick;

    if (action === 'qr') {
      void handleSyncQrToPowerPoint(true);
      switchTabWithWindowMode('trigger');
    } else if (action === 'history') {
      switchTabWithWindowMode('history');
    } else if (action === 'trigger') {
      void handleSyncQrToPowerPoint(false);
      switchTabWithWindowMode('trigger');
    } else if (action === 'vote') {
      void handleSyncQrToPowerPoint(false);
      switchTabWithWindowMode('trigger');
    }
  }, [searchParams, session, switchTabWithWindowMode, handleSyncQrToPowerPoint]);

  // 4. Abonnement Temps Réel
  useEffect(() => {
    if (!session?.id) return;

    const unsubscribe = pollService.subscribeToSessionRealtime(session.id, {
      onSessionUpdate: (s) => setSession(s),
      onQuestionsChange: (q) => setQuestions(q),
      onParticipantsChange: (p) => setParticipants(p),
      onVotesChange: (v) => setVotes(v),
    });

    return () => unsubscribe();
  }, [session?.id]);

  // Question / Résolution actuellement active
  const activeQuestion = useMemo(() => {
    if (!session?.active_question_id) return null;
    return questions.find((q) => q.id === session.active_question_id) ?? null;
  }, [session?.active_question_id, questions]);

  // Statistiques OUI / NON / ABSTENTION pour la question active
  const activeStats = useMemo(() => {
    if (!activeQuestion) return null;
    const qVotes = votes.filter((v) => v.question_id === activeQuestion.id);
    const total = qVotes.length;
    const opts =
      activeQuestion.options.length > 0
        ? activeQuestion.options
        : ['OUI', 'NON', 'ABSTENTION'];

    let ouiCount = 0;
    let nonCount = 0;
    let absCount = 0;

    const items = opts.map((opt) => {
      const upper = opt.trim().toUpperCase();
      const count = qVotes.filter((v) => v.answer.trim().toUpperCase() === upper).length;
      const percent = total > 0 ? Math.round((count / total) * 100) : 0;

      if (upper === 'OUI') ouiCount += count;
      else if (upper === 'NON') nonCount += count;
      else absCount += count;

      return { label: opt, upper, count, percent };
    });

    const ouiPct = total > 0 ? Math.round((ouiCount / total) * 100) : 0;
    const nonPct = total > 0 ? Math.round((nonCount / total) * 100) : 0;
    const absPct = total > 0 ? Math.round((absCount / total) * 100) : 0;

    const expressed = ouiCount + nonCount;
    const decision: 'ADOPTED' | 'REJECTED' | 'NONE' =
      expressed > 0 ? (ouiCount > nonCount ? 'ADOPTED' : 'REJECTED') : 'NONE';

    return {
      items,
      total,
      ouiCount,
      nonCount,
      absCount,
      ouiPct,
      nonPct,
      absPct,
      decision,
    };
  }, [activeQuestion, votes]);

  // Navigation Slide Suivante / Précédente dans PowerPoint
  const handleNextSlide = useCallback(async () => {
    if (!session) return;
    if (window.powerpointBridge && pptStatus.connected) {
      const st = await window.powerpointBridge.nextSlide();
      if (st) {
        setPptStatus(st);
        lastSyncedPptSlideRef.current = st.currentSlide;
        await pollService.updateSessionState(session.id, {
          current_slide: st.currentSlide,
        });
        return;
      }
    }
    const next = currentSlide + 1;
    setSession((prev) => (prev ? { ...prev, current_slide: next } : prev));
    await pollService.updateSessionState(session.id, { current_slide: next });
  }, [session, pptStatus.connected, currentSlide]);

  const handlePrevSlide = useCallback(async () => {
    if (!session) return;
    if (window.powerpointBridge && pptStatus.connected) {
      const st = await window.powerpointBridge.prevSlide();
      if (st) {
        setPptStatus(st);
        lastSyncedPptSlideRef.current = st.currentSlide;
        await pollService.updateSessionState(session.id, {
          current_slide: st.currentSlide,
        });
        return;
      }
    }
    const prevSlideNum = Math.max(1, currentSlide - 1);
    setSession((prev) => (prev ? { ...prev, current_slide: prevSlideNum } : prev));
    await pollService.updateSessionState(session.id, { current_slide: prevSlideNum });
  }, [session, pptStatus.connected, currentSlide]);

  const handleStartPptSlideShow = async () => {
    if (window.powerpointBridge) {
      const st = await window.powerpointBridge.startSlideShow();
      if (st) setPptStatus(st);
    }
  };

  // Clôturer le vote ET insérer automatiquement une diapositive de résultats juste en dessous dans PowerPoint
  const handleCloseAndInsertResultSlide = async () => {
    if (!activeQuestion || !session || !activeStats) return;

    // Si le vote est déjà clôturé et qu'on clique sur "Rouvrir le vote"
    if (!activeQuestion.is_open) {
      const updatedQ = await pollService.updateQuestion(activeQuestion.id, {
        is_open: true,
      });
      setQuestions((prev) => prev.map((q) => (q.id === updatedQ.id ? updatedQ : q)));
      setResultSlideMessage(null);
      return;
    }

    setInsertingSlide(true);
    try {
      // 1. Clôturer le scrutin
      const updatedQ = await pollService.updateQuestion(activeQuestion.id, {
        is_open: false,
      });
      setQuestions((prev) => prev.map((q) => (q.id === updatedQ.id ? updatedQ : q)));
      setVotingSlideNumber(null);

      // 2. Insérer la nouvelle diapositive de résultats juste en dessous du slide de vote dans PowerPoint
      if (window.powerpointBridge?.insertResultSlide) {
        const st = await window.powerpointBridge.insertResultSlide({
          slideNumber: votingSlideNumber ?? currentSlide,
          questionTitle: activeQuestion.title,
          ouiCount: activeStats.ouiCount,
          ouiPct: activeStats.ouiPct,
          nonCount: activeStats.nonCount,
          nonPct: activeStats.nonPct,
          abstCount: activeStats.absCount,
          abstPct: activeStats.absPct,
          totalVotes: activeStats.total,
          sessionCode: session.code,
        });
        if (st) {
          setPptStatus(st);
          setResultSlideMessage(
            `Diapositive de résultats créée et insérée en Slide n°${st.currentSlide} dans votre PowerPoint !`
          );
        } else {
          setResultSlideMessage('Vote clôturé.');
        }
      } else {
        setResultSlideMessage('Vote clôturé.');
      }
    } catch (err) {
      console.error(err);
    } finally {
      setInsertingSlide(false);
    }
  };

  // Réinsérer manuellement la diapositive de résultat si besoin
  const handleManualInsertResultSlide = async () => {
    if (!activeQuestion || !session || !activeStats || !window.powerpointBridge?.insertResultSlide) {
      return;
    }
    setInsertingSlide(true);
    try {
      const st = await window.powerpointBridge.insertResultSlide({
        slideNumber: currentSlide,
        questionTitle: activeQuestion.title,
        ouiCount: activeStats.ouiCount,
        ouiPct: activeStats.ouiPct,
        nonCount: activeStats.nonCount,
        nonPct: activeStats.nonPct,
        abstCount: activeStats.absCount,
        abstPct: activeStats.absPct,
        totalVotes: activeStats.total,
        sessionCode: session.code,
      });
      if (st) {
        setPptStatus(st);
        setResultSlideMessage(
          `Diapositive de résultats insérée en Slide n°${st.currentSlide} dans votre PowerPoint !`
        );
      }
    } finally {
      setInsertingSlide(false);
    }
  };

  const handleToggleShowResults = async () => {
    if (!session) return;
    const updated = await pollService.updateSessionState(session.id, {
      show_results: !session.show_results,
    });
    setSession(updated);
  };

  const handleDeleteResolution = async (id: string) => {
    if (!session) return;
    await pollService.deleteQuestion(id);
    const refreshed = await pollService.getQuestionsBySession(session.id);
    setQuestions(refreshed);
  };

  const handleClearParticipants = async () => {
    if (!session) return;
    const confirmed = window.confirm(
      `Voulez-vous remettre à zéro la liste des votants connectés (${participants.length}) et leurs codes à 4 chiffres ?`
    );
    if (!confirmed) return;
    await pollService.clearSessionParticipants(session.id);
    try {
      await fetch('/api/ppt-action?op=clear_participants');
    } catch {}
    setParticipants([]);
    setVotes([]);
  };

  const handleCopyLink = async () => {
    if (!joinUrl) return;
    await navigator.clipboard.writeText(joinUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  // Réagir au clic sur le bouton natif "▶ LANCER LE VOTE SUR CE SLIDE" intégré directement dans la diapositive PowerPoint
  const isActionInProgressRef = useRef<boolean>(false);
  const lastHandledClickSeqRef = useRef<number>(0);
  useEffect(() => {
    if (
      slideButtonClickSeq <= 0 ||
      slideButtonClickSeq === lastHandledClickSeqRef.current ||
      isActionInProgressRef.current
    ) {
      return;
    }
    lastHandledClickSeqRef.current = slideButtonClickSeq;

    const isThisSlideOpen = Boolean(
      activeQuestion &&
        activeQuestion.is_open &&
        votingSlideNumber !== null &&
        votingSlideNumber === currentSlide
    );

    isActionInProgressRef.current = true;
    if (isThisSlideOpen) {
      void handleCloseAndInsertResultSlide().finally(() => {
        isActionInProgressRef.current = false;
      });
    } else {
      void handleLaunchResolutionVote(true).finally(() => {
        isActionInProgressRef.current = false;
      });
    }
  });

  // Mettre à jour en direct le compteur de votes sur le bouton intégré dans la diapositive PowerPoint
  useEffect(() => {
    if (!window.powerpointBridge?.updateSlideButton) {
      return;
    }
    const isThisSlideOpen = Boolean(
      activeQuestion &&
        activeQuestion.is_open &&
        votingSlideNumber !== null &&
        votingSlideNumber === currentSlide
    );
    void window.powerpointBridge.updateSlideButton({
      slideNumber: currentSlide,
      isOpen: isThisSlideOpen,
      voteCount: isThisSlideOpen && activeStats ? activeStats.total : 0,
      ouiCount: isThisSlideOpen && activeStats ? activeStats.ouiCount : 0,
      nonCount: isThisSlideOpen && activeStats ? activeStats.nonCount : 0,
      abstCount: isThisSlideOpen && activeStats ? activeStats.absCount : 0,
    });
  }, [
    activeQuestion?.id,
    activeQuestion?.is_open,
    activeStats?.total,
    activeStats?.ouiCount,
    activeStats?.nonCount,
    activeStats?.absCount,
    votingSlideNumber,
    currentSlide,
  ]);

  if (!session) {
    return (
      <div className="h-screen w-screen bg-slate-950 flex items-center justify-center text-white text-sm font-bold">
        Initialisation de la séance de vote...
      </div>
    );
  }

  // ===========================================================================
  // MINI-BARRE DISCRÈTE EN HAUT À DROITE (Laisse la diapositive PowerPoint 100% visible)
  // ===========================================================================
  if (activeTab === 'trigger') {
    const isVoteOpen = Boolean(
      activeQuestion &&
        activeQuestion.is_open &&
        votingSlideNumber !== null &&
        votingSlideNumber === currentSlide
    );

    return (
      <div className="h-screen w-screen bg-slate-950 text-white px-3 py-2 flex flex-col justify-between select-none border border-emerald-500/40">
        {/* Canvas caché pour l'export PNG du QR Code vers PowerPoint */}
        <div className="hidden">
          <QRCodeCanvas
            id="ppt-export-qr-canvas"
            value={joinUrl}
            size={420}
            level="H"
            includeMargin={true}
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                isVoteOpen ? 'bg-amber-400 animate-ping' : 'bg-emerald-400'
              }`}
            />
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-emerald-300 truncate">
              Slide {currentSlide} • Code {session.code} ({participants.length} connecté
              {participants.length > 1 ? 's' : ''})
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => void handleSyncQrToPowerPoint(true)}
              title="Intégrer le QR Code et le bouton directement dans le slide PowerPoint"
              className="px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-[10px] font-bold text-white"
            >
              Intégrer dans Slide
            </button>
            <button
              type="button"
              onClick={() => void handleClearParticipants()}
              title="Remettre à zéro la base des votants connectés"
              className="px-2 py-0.5 rounded bg-rose-600/80 hover:bg-rose-600 text-[10px] font-bold text-white"
            >
              RAZ Votants ({participants.length})
            </button>
            <button
              type="button"
              onClick={() => switchTabWithWindowMode('history')}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-bold text-slate-200"
            >
              PV ({questions.length})
            </button>
          </div>
        </div>

        {isVoteOpen && activeStats ? (
          <button
            type="button"
            disabled={insertingSlide}
            onClick={() => void handleCloseAndInsertResultSlide()}
            className="w-full py-2 px-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs shadow-lg flex items-center justify-between gap-2 transition"
          >
            <span className="flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 shrink-0" />
              <span>CLÔTURER & CRÉER DIAPO RÉSULTAT</span>
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-950/20 text-[11px] font-extrabold">
              {activeStats.total} vote{activeStats.total > 1 ? 's' : ''} (OUI:{activeStats.ouiCount} NON:{activeStats.nonCount} ABST:{activeStats.absCount})
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleLaunchResolutionVote(true)}
            className="w-full py-2 px-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white font-black text-xs shadow-lg flex items-center justify-center gap-2 transition"
          >
            <Play className="w-3.5 h-3.5 fill-white shrink-0" />
            <span>LANCER LE VOTE (ou cliquez sur le bouton dans le slide)</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-100 flex flex-col overflow-hidden select-none">
      {/* Canvas caché pour l'export PNG du QR Code vers PowerPoint */}
      <div className="hidden">
        <QRCodeCanvas
          id="ppt-export-qr-canvas"
          value={joinUrl}
          size={420}
          level="H"
          includeMargin={true}
        />
      </div>

      {/* =====================================================================
          BARRE SUPÉRIEURE FIXE
         ===================================================================== */}
      <header className="bg-slate-900 border-b border-white/10 px-4 py-3 shrink-0 space-y-2.5">
        {/* Ligne 1 : Statut PowerPoint & Navigation Slides */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-emerald-600 flex items-center justify-center shrink-0">
              <VoteIcon className="w-4 h-4 text-white" />
            </div>
            <div className="truncate">
              <div className="flex items-center gap-2">
                <span className="text-xs font-black uppercase tracking-wider text-emerald-400">
                  Vote en Direct
                </span>
                <span className="px-2 py-0.5 rounded bg-indigo-500/20 border border-indigo-500/40 font-mono text-xs font-extrabold text-indigo-300">
                  CODE : {session.code}
                </span>
              </div>
              <p className="text-xs text-slate-300 truncate">
                {pptStatus.connected
                  ? pptStatus.presentationName || 'Présentation PowerPoint connectée'
                  : 'Synchronisé avec PowerPoint'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Bouton pour réduire en "Bouton sur le Slide" (à l'emplacement de la croix X) */}
            <button
              type="button"
              onClick={() => switchTabWithWindowMode('trigger')}
              title="Réduire en bouton de déclenchement en bas à droite du slide"
              className="px-2.5 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-xs font-extrabold flex items-center gap-1.5 transition"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              <span>Bouton sur Slide</span>
            </button>

            {/* Sélecteur Slide PowerPoint */}
            <div className="flex items-center gap-1 px-2 py-1 rounded-xl bg-slate-950 border border-white/10 shrink-0">
              <button
                type="button"
                onClick={() => void handlePrevSlide()}
                title="Slide PowerPoint précédente"
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-200 transition"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              <div className="px-1.5 text-center">
                <div className="text-xs font-extrabold text-white flex items-center justify-center gap-1.5">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      pptStatus.connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
                    }`}
                  />
                  <span>
                    Slide {currentSlide} /{' '}
                    {pptStatus.connected ? pptStatus.totalSlides : totalSlides}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => void handleNextSlide()}
                title="Slide PowerPoint suivante"
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-200 transition"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Ligne 2 : Les Boutons d'Action */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* 1. Onglet QR Code */}
          <button
            type="button"
            onClick={() => switchTabWithWindowMode('qr')}
            className={`py-2 px-3 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 border transition ${
              activeTab === 'qr'
                ? 'bg-indigo-600 text-white border-indigo-400 shadow-lg'
                : 'bg-slate-950 hover:bg-slate-800 text-slate-200 border-white/10'
            }`}
          >
            <QrCode className="w-3.5 h-3.5" />
            <span>QR Code</span>
            <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
              {participants.length}
            </span>
          </button>

          {/* 1bis. Bouton Administrateur : Remettre à zéro la base des votants */}
          <button
            type="button"
            onClick={() => void handleClearParticipants()}
            title="Vider la liste des personnes connectées et leurs codes à 4 chiffres"
            className="py-2 px-3 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 border bg-rose-600/20 hover:bg-rose-600/35 text-rose-200 border-rose-500/40 transition"
          >
            <Trash2 className="w-3.5 h-3.5 text-rose-400" />
            <span>RAZ Votants ({participants.length})</span>
          </button>

          {/* 2. Bouton Lancer le Vote sur ce Slide */}
          <button
            type="button"
            onClick={() => void handleLaunchResolutionVote()}
            className="flex-1 py-2 px-3 rounded-xl text-xs font-black tracking-wide flex items-center justify-center gap-1.5 border bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white border-emerald-300 shadow-lg transition"
          >
            <Play className="w-3.5 h-3.5 fill-white" />
            <span>DÉCLENCHER LE VOTE (SLIDE {currentSlide})</span>
          </button>

          {/* 3. Onglet PV & Résultats */}
          <button
            type="button"
            onClick={() => switchTabWithWindowMode('history')}
            className={`py-2 px-3 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 border transition ${
              activeTab === 'history'
                ? 'bg-indigo-600 text-white border-indigo-400 shadow-lg'
                : 'bg-slate-950 hover:bg-slate-800 text-slate-200 border-white/10'
            }`}
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
            <span>PV ({questions.length})</span>
          </button>

          {pptStatus.connected && !pptStatus.inSlideShow && (
            <button
              type="button"
              onClick={() => void handleStartPptSlideShow()}
              className="py-2 px-2.5 rounded-xl bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/40 text-orange-300 text-xs font-bold flex items-center gap-1 transition"
            >
              <MonitorPlay className="w-3.5 h-3.5" />
              <span>F5</span>
            </button>
          )}
        </div>
      </header>

      {/* =====================================================================
          ZONE PRINCIPALE
         ===================================================================== */}
      <main className="flex-1 overflow-y-auto p-4 sm:p-5 flex flex-col justify-center">
        {/* -------------------------------------------------------------------
            ONGLET 1 : QR CODE VOTANTS
           ------------------------------------------------------------------- */}
        {activeTab === 'qr' && (
          <div className="max-w-3xl w-full mx-auto bg-slate-900 border border-white/15 rounded-3xl p-6 shadow-2xl grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
            <div className="md:col-span-5 flex flex-col items-center text-center">
              <div className="p-5 bg-white rounded-3xl shadow-2xl border-4 border-indigo-500/30">
                <QRCodeSVG value={joinUrl} size={210} level="H" />
              </div>
              <p className="text-xs text-slate-400 mt-3">
                Scannez avec l'appareil photo du GSM
              </p>
              <button
                type="button"
                onClick={() => void handleSyncQrToPowerPoint(true)}
                className="mt-3 px-3 py-2 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/40 text-indigo-200 text-xs font-bold flex items-center gap-1.5 transition"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Injecter ce QR Code sur les slides PowerPoint
              </button>
              {qrSyncedMessage && (
                <p className="text-[11px] text-emerald-400 font-bold mt-2">
                  {qrSyncedMessage}
                </p>
              )}
            </div>

            <div className="md:col-span-7 space-y-4">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-indigo-400">
                  Vote en Direct
                </span>
                <h2 className="text-xl font-extrabold text-white mt-0.5">
                  Rejoindre la séance de vote
                </h2>
              </div>

              <div className="p-4 rounded-2xl bg-slate-950 border border-indigo-500/30 flex items-center justify-between gap-4">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                    Code de séance
                  </p>
                  <p className="text-3xl sm:text-4xl font-mono font-black tracking-widest text-emerald-400">
                    {session.code}
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyLink()}
                    className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-white flex items-center justify-center gap-1.5 transition"
                  >
                    {copiedLink ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        Lien copié
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copier le lien
                      </>
                    )}
                  </button>

                  <a
                    href={`/join/${session.code}`}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white flex items-center justify-center gap-1.5 transition shadow"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Simuler un votant
                  </a>
                </div>
              </div>

              {/* Liste en direct des participants connectés */}
              <div className="p-4 rounded-2xl bg-slate-950/80 border border-white/10">
                <div className="flex items-center justify-between mb-2 gap-2">
                  <span className="text-xs font-bold text-white flex items-center gap-1.5">
                    <Users className="w-4 h-4 text-emerald-400" />
                    Participants présents ({participants.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleClearParticipants()}
                    className="px-2.5 py-1 rounded-lg text-xs font-bold bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 flex items-center gap-1 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Remettre à zéro les votants
                  </button>
                </div>

                {participants.length === 0 ? (
                  <p className="text-xs text-slate-400 py-2 text-center">
                    En attente des participants...
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                    {participants.map((p) => (
                      <span
                        key={p.id}
                        className="px-3 py-1 rounded-xl bg-indigo-500/20 border border-indigo-400/30 text-xs font-bold text-white flex items-center gap-1.5"
                      >
                        <span className="w-2 h-2 rounded-full bg-emerald-400" />
                        {p.nickname}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => switchTabWithWindowMode('trigger')}
                  className="py-3 px-4 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-emerald-500/40 text-emerald-300 font-extrabold text-xs flex items-center justify-center gap-2 transition"
                >
                  <Minimize2 className="w-4 h-4" />
                  Placer le bouton sur le Slide
                </button>

                <button
                  type="button"
                  onClick={() => void handleLaunchResolutionVote()}
                  className="py-3 px-4 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white font-black text-xs shadow-lg flex items-center justify-center gap-2 transition"
                >
                  <Play className="w-4 h-4 fill-white" />
                  Déclencher le vote (Slide {currentSlide})
                </button>
              </div>
            </div>
          </div>
        )}

        {/* -------------------------------------------------------------------
            ONGLET 2 : SCRUTIN EN DIRECT (OUI / NON / ABSTENTION)
           ------------------------------------------------------------------- */}
        {activeTab === 'vote' && (
          <div className="max-w-2xl w-full mx-auto space-y-3.5">
            {!activeQuestion || !activeStats ? (
              <div className="bg-slate-900 border border-white/15 rounded-3xl p-6 text-center space-y-4">
                <VoteIcon className="w-10 h-10 text-emerald-400 mx-auto" />
                <h2 className="text-lg font-extrabold text-white">
                  Prêt à déclencher le vote sur la Slide {currentSlide}
                </h2>
                <p className="text-xs text-slate-400">
                  {pptStatus.slideTitle ||
                    'Cliquez ci-dessous pour ouvrir le vote OUI / NON / ABSTENTION.'}
                </p>
                <button
                  type="button"
                  onClick={() => void handleLaunchResolutionVote()}
                  className="w-full py-4 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white font-black text-sm shadow-lg flex items-center justify-center gap-2"
                >
                  <Play className="w-5 h-5 fill-white" />
                  DÉCLENCHER LE VOTE SUR CE SLIDE
                </button>
              </div>
            ) : (
              <div className="bg-slate-900 border border-white/15 rounded-3xl p-4 sm:p-5 shadow-2xl space-y-3.5">
                {/* En-tête du texte soumis au vote */}
                <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-xs font-bold flex items-center gap-1.5 border ${
                          activeQuestion.is_open
                            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                            : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                        }`}
                      >
                        <span
                          className={`w-2 h-2 rounded-full ${
                            activeQuestion.is_open
                              ? 'bg-emerald-400 animate-ping'
                              : 'bg-amber-400'
                          }`}
                        />
                        {activeQuestion.is_open ? 'Scrutin ouvert (1 vote/pers.)' : 'Scrutin clôturé'}
                      </span>
                      <span className="text-xs font-bold text-indigo-400 uppercase">
                        Slide {activeQuestion.slide_number || currentSlide}
                      </span>
                    </div>
                    <h2 className="text-sm sm:text-base font-extrabold text-white leading-snug">
                      {activeQuestion.title}
                    </h2>
                  </div>

                  {/* Mini QR Code toujours visible en haut à droite du vote */}
                  <button
                    type="button"
                    onClick={() => switchTabWithWindowMode('qr')}
                    title="Cliquez pour agrandir le QR Code"
                    className="p-1.5 bg-white rounded-xl shrink-0 hover:scale-105 transition shadow"
                  >
                    <QRCodeSVG value={joinUrl} size={48} level="L" />
                  </button>
                </div>

                {/* Compteur de participation */}
                <div className="px-3.5 py-2 rounded-2xl bg-slate-950 border border-white/10 flex items-center justify-between">
                  <span className="text-xs text-slate-300 flex items-center gap-2 font-medium">
                    <Users className="w-4 h-4 text-emerald-400" />
                    Votes définitifs reçus
                  </span>
                  <span className="text-sm font-black text-white">
                    {activeStats.total} vote{activeStats.total > 1 ? 's' : ''}{' '}
                    <span className="text-xs font-normal text-slate-400">
                      / {participants.length} inscrit{participants.length > 1 ? 's' : ''}
                    </span>
                  </span>
                </div>

                {/* Confirmation de l'insertion de la diapositive de résultats */}
                {resultSlideMessage && (
                  <div className="p-3 rounded-2xl bg-indigo-500/20 border border-indigo-400/50 text-indigo-100 text-xs font-bold flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>{resultSlideMessage}</span>
                  </div>
                )}

                {/* Décision officielle après clôture */}
                {!activeQuestion.is_open && (
                  <div
                    className={`p-3.5 rounded-2xl border-2 flex items-center justify-between gap-3 ${
                      activeStats.decision === 'ADOPTED'
                        ? 'bg-emerald-500/20 border-emerald-400 text-emerald-100'
                        : activeStats.decision === 'REJECTED'
                        ? 'bg-rose-500/20 border-rose-400 text-rose-100'
                        : 'bg-slate-800 border-slate-600 text-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      {activeStats.decision === 'ADOPTED' ? (
                        <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
                      ) : activeStats.decision === 'REJECTED' ? (
                        <XCircle className="w-6 h-6 text-rose-400 shrink-0" />
                      ) : (
                        <MinusCircle className="w-6 h-6 text-slate-400 shrink-0" />
                      )}
                      <div>
                        <p className="text-sm font-black uppercase">
                          {activeStats.decision === 'ADOPTED' && 'PROPOSITION ADOPTÉE'}
                          {activeStats.decision === 'REJECTED' && 'PROPOSITION REJETÉE'}
                          {activeStats.decision === 'NONE' && 'AUCUN SUFFRAGE EXPRIMÉ'}
                        </p>
                        <p className="text-xs opacity-90">
                          OUI : {activeStats.ouiCount} ({activeStats.ouiPct}%) • NON :{' '}
                          {activeStats.nonCount} ({activeStats.nonPct}%) • ABST :{' '}
                          {activeStats.absCount} ({activeStats.absPct}%)
                        </p>
                      </div>
                    </div>

                    {window.powerpointBridge?.insertResultSlide && (
                      <button
                        type="button"
                        disabled={insertingSlide}
                        onClick={() => void handleManualInsertResultSlide()}
                        className="px-2.5 py-1.5 rounded-xl bg-white/15 hover:bg-white/25 text-white text-[11px] font-bold flex items-center gap-1 shrink-0"
                      >
                        <FilePlus2 className="w-3.5 h-3.5" />
                        Réinsérer diapo
                      </button>
                    )}
                  </div>
                )}

                {/* Barres OUI / NON / ABSTENTION */}
                {!session.show_results ? (
                  <div className="py-6 text-center text-xs text-slate-400 bg-slate-950/60 rounded-2xl border border-white/10">
                    <EyeOff className="w-5 h-5 mx-auto mb-1.5 text-slate-400" />
                    Résultats masqués pendant le vote ({activeStats.total} vote reçu)
                  </div>
                ) : (
                  <div className="space-y-2">
                    {activeStats.items.map((item) => {
                      let barColor = 'from-sky-400 to-blue-500';
                      let badgeColor = 'text-sky-400';
                      let IconComp = MinusCircle;

                      if (item.upper === 'OUI') {
                        barColor = 'from-emerald-500 to-teal-400';
                        badgeColor = 'text-emerald-400';
                        IconComp = CheckCircle2;
                      } else if (item.upper === 'NON') {
                        barColor = 'from-rose-500 to-red-500';
                        badgeColor = 'text-rose-400';
                        IconComp = XCircle;
                      }

                      return (
                        <div
                          key={item.label}
                          className="p-3 rounded-2xl bg-slate-950 border border-white/10"
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <IconComp className={`w-4 h-4 ${badgeColor}`} />
                              <span className="font-extrabold text-sm text-white uppercase">
                                {item.label}
                              </span>
                            </div>
                            <div>
                              <span className="text-sm font-black text-white">
                                {item.count} voix
                              </span>
                              <span className="text-xs font-bold text-slate-400 ml-1.5">
                                ({item.percent}%)
                              </span>
                            </div>
                          </div>

                          <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full bg-gradient-to-r ${barColor} transition-all duration-500`}
                              style={{
                                width: `${Math.max(item.percent, item.count > 0 ? 5 : 0)}%`,
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Boutons Clôturer & Insérer la diapo de résultat / Masquer */}
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={insertingSlide}
                    onClick={() => void handleCloseAndInsertResultSlide()}
                    className={`flex-1 py-3.5 px-4 rounded-xl text-xs sm:text-sm font-extrabold flex items-center justify-center gap-2 transition ${
                      activeQuestion.is_open
                        ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-lg'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-white/10'
                    }`}
                  >
                    {activeQuestion.is_open ? (
                      <>
                        <Lock className="w-4 h-4 shrink-0" />
                        <span>
                          {insertingSlide
                            ? 'Insertion de la diapo de résultat...'
                            : 'Clôturer & Insérer Diapo Résultat'}
                        </span>
                      </>
                    ) : (
                      <>
                        <Unlock className="w-4 h-4 shrink-0" />
                        <span>Rouvrir ce vote</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleToggleShowResults()}
                    title="Afficher / Masquer les barres"
                    className="p-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 text-slate-200 transition"
                  >
                    {session.show_results ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* -------------------------------------------------------------------
            ONGLET 3 : PROCÈS-VERBAL & EXPORT EXCEL/CSV
           ------------------------------------------------------------------- */}
        {activeTab === 'history' && (
          <div className="max-w-3xl w-full mx-auto bg-slate-900 border border-white/15 rounded-3xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-4">
              <div>
                <h2 className="text-lg font-extrabold text-white">
                  Procès-Verbal des Votes ({questions.length})
                </h2>
                <p className="text-xs text-slate-400">
                  Historique de tous les textes votés pendant la séance
                </p>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => void handleClearParticipants()}
                  className="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-xs font-bold text-white flex items-center gap-2 shadow-lg transition"
                >
                  <Trash2 className="w-4 h-4" />
                  Vider la base des votants ({participants.length})
                </button>
                <button
                  type="button"
                  onClick={() =>
                    pollService.exportSessionResultsToCsv(
                      session,
                      questions,
                      participants,
                      votes
                    )
                  }
                  className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white flex items-center gap-2 shadow-lg transition"
                >
                  <Download className="w-4 h-4" />
                  Télécharger CSV / Excel
                </button>
              </div>
            </div>

            {/* Liste des participants connectés et de leurs codes personnels à 4 chiffres */}
            <div className="p-4 rounded-2xl bg-slate-950 border border-indigo-500/30 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-extrabold uppercase tracking-wider text-indigo-300 flex items-center gap-2">
                  <Users className="w-4 h-4 text-emerald-400" />
                  Participants connectés &amp; Codes à 4 chiffres ({participants.length})
                </span>
                <span className="text-[11px] text-slate-400">
                  En cas d'oubli du code sur GSM, lisez-lui son numéro #XXXX ci-dessous
                </span>
              </div>

              {participants.length === 0 ? (
                <p className="text-xs text-slate-400 py-2 text-center">
                  Aucun participant inscrit pour le moment.
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-44 overflow-y-auto pr-1">
                  {participants.map((p) => {
                    const baseName = pollService.extractParticipantBaseName(p.nickname);
                    const pin = pollService.extractParticipantPin(p);
                    return (
                      <div
                        key={p.id}
                        className="px-3 py-2 rounded-xl bg-slate-900 border border-white/10 flex items-center justify-between gap-2"
                      >
                        <span className="text-xs font-bold text-white truncate">
                          {baseName}
                        </span>
                        <span className="px-2 py-0.5 rounded-lg bg-amber-500/20 border border-amber-400/40 text-amber-300 font-mono text-xs font-black shrink-0">
                          #{pin}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {questions.length === 0 ? (
              <p className="text-xs text-slate-400 py-8 text-center">
                Aucun texte voté pour le moment.
              </p>
            ) : (
              <div className="space-y-2.5 max-h-[55vh] overflow-y-auto pr-1">
                {questions.map((q) => {
                  const qVotes = votes.filter((v) => v.question_id === q.id);
                  const oui = qVotes.filter((v) => v.answer.toUpperCase() === 'OUI').length;
                  const non = qVotes.filter((v) => v.answer.toUpperCase() === 'NON').length;
                  const abs = qVotes.filter(
                    (v) => v.answer.toUpperCase() === 'ABSTENTION'
                  ).length;
                  const expressed = oui + non;

                  return (
                    <div
                      key={q.id}
                      className="p-3.5 rounded-2xl bg-slate-950 border border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-indigo-500/20 text-indigo-300">
                            Slide {q.slide_number || '-'}
                          </span>
                          {expressed > 0 && (
                            <span
                              className={`px-2 py-0.5 rounded text-[11px] font-extrabold ${
                                oui > non
                                  ? 'bg-emerald-500/20 text-emerald-300'
                                  : 'bg-rose-500/20 text-rose-300'
                              }`}
                            >
                              {oui > non ? 'ADOPTÉ' : 'REJETÉ'}
                            </span>
                          )}
                        </div>
                        <p className="text-sm font-bold text-white">{q.title}</p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 text-xs font-bold">
                        <span className="px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-300">
                          OUI : {oui}
                        </span>
                        <span className="px-2.5 py-1 rounded-lg bg-rose-500/15 text-rose-300">
                          NON : {non}
                        </span>
                        <span className="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300">
                          ABST. : {abs}
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleDeleteResolution(q.id)}
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
