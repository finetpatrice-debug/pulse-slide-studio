import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { RefreshCw, AlertCircle, Vote, MonitorPlay } from 'lucide-react';
import { pollService } from '../services/pollService';
import { usePresentation } from '../context/PresentationContext';
import FloatingToolbar from '../components/presenter/FloatingToolbar';
import QrCodeModalOverlay from '../components/presenter/QrCodeModalOverlay';
import ActivePollOverlay from '../components/presenter/ActivePollOverlay';
import type { Session, Question, Participant, Vote as VoteType } from '../types/poll';

export default function PresenterSlideshowPage() {
  const { sessionCode } = useParams<{ sessionCode: string }>();
  const navigate = useNavigate();
  const { totalSlides, setTotalSlides } = usePresentation();

  const isElectron = Boolean(window.powerpointBridge?.isElectron);

  // États Temps Réel
  const [session, setSession] = useState<Session | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [votes, setVotes] = useState<VoteType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // États Microsoft PowerPoint (via Bridge COM Windows)
  const [pptConnected, setPptConnected] = useState(false);
  const [pptInSlideShow, setPptInSlideShow] = useState(false);
  const [pptPresentationName, setPptPresentationName] = useState<string | null>(null);
  const [pptSlideTitle, setPptSlideTitle] = useState<string>('');
  const [pptSlideText, setPptSlideText] = useState<string>('');
  const lastSyncedPptSlideRef = useRef<number>(1);

  // États UI Surcouche
  const [showQrModal, setShowQrModal] = useState(false);
  const [pollMinimized, setPollMinimized] = useState(false);
  const [isHoveringUi, setIsHoveringUi] = useState(false);

  // 1. Activer le mode Surcouche Transparente Always-on-Top dans Electron au montage
  useEffect(() => {
    if (window.powerpointBridge) {
      void window.powerpointBridge.setWindowMode('overlay');
    }
    return () => {
      if (window.powerpointBridge) {
        window.powerpointBridge.setIgnoreMouseEvents(false);
        void window.powerpointBridge.setWindowMode('dashboard');
      }
    };
  }, []);

  // 2. Traversée des clics vers PowerPoint (Click-Through)
  // Seuls la barre du bas et le panneau de vote captent les clics ; le reste traverse vers PowerPoint !
  const shouldCaptureMouse = showQrModal || isHoveringUi;

  useEffect(() => {
    if (!window.powerpointBridge) return;
    window.powerpointBridge.setIgnoreMouseEvents(!shouldCaptureMouse);
  }, [shouldCaptureMouse]);

  // 3. Synchronisation automatique avec Microsoft PowerPoint (numéro de slide + texte du slide)
  useEffect(() => {
    if (!window.powerpointBridge) return;

    let active = true;
    const syncPowerPoint = async () => {
      try {
        const status = await window.powerpointBridge!.getStatus();
        if (!active || !status) return;

        setPptConnected(status.connected);
        setPptInSlideShow(status.inSlideShow);
        setPptPresentationName(status.presentationName);
        setPptSlideTitle(status.slideTitle || '');
        setPptSlideText(status.slideText || '');

        if (status.connected && status.totalSlides >= 1) {
          setTotalSlides(status.totalSlides);
        }

        if (
          status.connected &&
          status.currentSlide >= 1 &&
          status.currentSlide !== lastSyncedPptSlideRef.current
        ) {
          lastSyncedPptSlideRef.current = status.currentSlide;
          setSession((prev) => {
            if (!prev || prev.current_slide === status.currentSlide) return prev;
            void pollService.updateSessionState(prev.id, {
              current_slide: status.currentSlide,
            });
            return { ...prev, current_slide: status.currentSlide };
          });
        }
      } catch {
        // Ignorer
      }
    };

    void syncPowerPoint();
    const timer = setInterval(syncPowerPoint, 450);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [setTotalSlides]);

  // 4. Chargement initial de la séance
  useEffect(() => {
    let cancelled = false;

    async function loadSessionData() {
      if (!sessionCode) {
        setError('Code de séance manquant.');
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const found = await pollService.getSessionByCode(sessionCode);
        if (cancelled) return;
        if (!found) {
          setError(`Séance "${sessionCode}" introuvable.`);
          setLoading(false);
          return;
        }

        setSession(found);
        lastSyncedPptSlideRef.current = found.current_slide;

        const [qList, pList, vList] = await Promise.all([
          pollService.getQuestionsBySession(found.id),
          pollService.getParticipantsBySession(found.id),
          pollService.getVotesBySession(found.id),
        ]);

        if (!cancelled) {
          setQuestions(qList);
          setParticipants(pList);
          setVotes(vList);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Erreur de chargement.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadSessionData();
    return () => {
      cancelled = true;
    };
  }, [sessionCode]);

  // 5. Abonnement Temps Réel Supabase
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

  const currentSlide = session?.current_slide ?? 1;

  // Navigation Slide Suivante / Précédente dans PowerPoint
  const handleNextSlide = useCallback(async () => {
    if (!session) return;
    if (window.powerpointBridge && pptConnected) {
      const st = await window.powerpointBridge.nextSlide();
      if (st && st.currentSlide) {
        lastSyncedPptSlideRef.current = st.currentSlide;
        setPptSlideTitle(st.slideTitle || '');
        setPptSlideText(st.slideText || '');
        setSession((prev) => (prev ? { ...prev, current_slide: st.currentSlide } : prev));
        await pollService.updateSessionState(session.id, {
          current_slide: st.currentSlide,
        });
        return;
      }
    }

    const next = Math.min(totalSlides || 30, currentSlide + 1);
    setSession((prev) => (prev ? { ...prev, current_slide: next } : prev));
    await pollService.updateSessionState(session.id, { current_slide: next });
  }, [session, pptConnected, totalSlides, currentSlide]);

  const handlePrevSlide = useCallback(async () => {
    if (!session) return;
    if (window.powerpointBridge && pptConnected) {
      const st = await window.powerpointBridge.prevSlide();
      if (st && st.currentSlide) {
        lastSyncedPptSlideRef.current = st.currentSlide;
        setPptSlideTitle(st.slideTitle || '');
        setPptSlideText(st.slideText || '');
        setSession((prev) => (prev ? { ...prev, current_slide: st.currentSlide } : prev));
        await pollService.updateSessionState(session.id, {
          current_slide: st.currentSlide,
        });
        return;
      }
    }

    const prevSlideNum = Math.max(1, currentSlide - 1);
    setSession((prev) => (prev ? { ...prev, current_slide: prevSlideNum } : prev));
    await pollService.updateSessionState(session.id, { current_slide: prevSlideNum });
  }, [session, pptConnected, currentSlide]);

  const handleStartPptSlideShow = async () => {
    if (window.powerpointBridge) {
      const st = await window.powerpointBridge.startSlideShow();
      if (st) {
        setPptConnected(st.connected);
        setPptInSlideShow(st.inSlideShow);
      }
    }
  };

  // Question actuellement active sur la séance
  const activeQuestion = useMemo(() => {
    if (!session?.active_question_id) return null;
    return questions.find((q) => q.id === session.active_question_id) ?? null;
  }, [session?.active_question_id, questions]);

  // ACTION PRINCIPALE : Lancer un vote OUI / NON / ABSTENTION sur le slide PowerPoint actuel
  const handleLaunchResolutionVote = async () => {
    if (!session) return;
    setPollMinimized(false);

    // Vérifier s'il existe déjà un texte préparé pour ce numéro de slide
    const existingForSlide = questions.find((q) => q.slide_number === currentSlide);
    if (existingForSlide && session.active_question_id !== existingForSlide.id) {
      const updatedSession = await pollService.launchQuestion(
        session.id,
        existingForSlide.id
      );
      setSession(updatedSession);
      const qList = await pollService.getQuestionsBySession(session.id);
      setQuestions(qList);
      return;
    }

    // Sinon, créer et lancer immédiatement le vote OUI / NON / ABSTENTION avec le texte détecté dans PowerPoint !
    const autoDetectedLabel =
      pptSlideTitle ||
      pptSlideText ||
      `Vote du texte — Slide PowerPoint n°${currentSlide}`;

    try {
      const { session: updatedSession } = await pollService.launchResolutionVote(
        session.id,
        currentSlide,
        autoDetectedLabel
      );
      setSession(updatedSession);
      const qList = await pollService.getQuestionsBySession(session.id);
      setQuestions(qList);
    } catch (err) {
      console.error(err);
    }
  };

  // Contrôles en direct du panneau de vote
  const handleToggleOpenVote = async () => {
    if (!activeQuestion || !session) return;
    const updatedQ = await pollService.updateQuestion(activeQuestion.id, {
      is_open: !activeQuestion.is_open,
    });
    setQuestions((prev) =>
      prev.map((q) => (q.id === updatedQ.id ? updatedQ : q))
    );
  };

  const handleToggleShowResults = async () => {
    if (!session) return;
    const updated = await pollService.updateSessionState(session.id, {
      show_results: !session.show_results,
    });
    setSession(updated);
  };

  const handleCloseActivePoll = async () => {
    if (!session) return;
    if (activeQuestion?.is_open) {
      await pollService.updateQuestion(activeQuestion.id, { is_open: false });
    }
    const updated = await pollService.updateSessionState(session.id, {
      active_question_id: null,
      reveal_answer: false,
    });
    setSession(updated);
    setPollMinimized(false);
  };

  const handleExitPresentation = async () => {
    if (window.powerpointBridge) {
      window.powerpointBridge.setIgnoreMouseEvents(false);
      await window.powerpointBridge.setWindowMode('dashboard');
    }
    navigate(session ? `/?session=${session.code}` : '/');
  };

  if (loading) {
    return (
      <div className="h-screen w-screen bg-slate-950/80 text-white flex flex-col items-center justify-center">
        <RefreshCw className="w-8 h-8 text-emerald-400 animate-spin mb-3" />
        <p className="text-sm font-medium text-slate-200">
          Activation de la barre de vote PowerPoint...
        </p>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="h-screen w-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6 text-center">
        <AlertCircle className="w-12 h-12 text-rose-400 mb-3" />
        <h1 className="text-xl font-bold mb-2">{error || 'Séance introuvable'}</h1>
        <button
          onClick={() => navigate('/')}
          className="mt-4 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm font-bold"
        >
          Retour à l'accueil
        </button>
      </div>
    );
  }

  return (
    <div
      className={`relative h-screen w-screen overflow-hidden select-none ${
        isElectron
          ? 'bg-transparent'
          : 'bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950'
      }`}
    >
      {/* Petit badge discret en haut à gauche */}
      <div
        onMouseEnter={() => setIsHoveringUi(true)}
        onMouseLeave={() => setIsHoveringUi(false)}
        className="fixed top-4 left-4 z-40 flex items-center gap-2.5 px-3.5 py-2 rounded-2xl bg-slate-950/90 backdrop-blur-xl border border-white/15 text-xs shadow-xl"
      >
        <Vote className="w-4 h-4 text-emerald-400" />
        <span className="font-bold text-white truncate max-w-[240px]">
          {pptPresentationName || session.title}
        </span>
        <span className="px-2 py-0.5 rounded-lg bg-emerald-500/20 border border-emerald-500/30 font-mono font-extrabold text-emerald-300">
          CODE : {session.code}
        </span>
      </div>

      {/* Si ouvert dans un navigateur web classique (hors Electron), aperçu du slide PowerPoint */}
      {!isElectron && (
        <div className="h-full w-full flex flex-col items-center justify-center p-8 text-center pointer-events-none">
          <div className="max-w-xl p-8 rounded-3xl bg-slate-900/80 border border-white/10 backdrop-blur-md space-y-3">
            <MonitorPlay className="w-12 h-12 text-emerald-400 mx-auto" />
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
              Slide PowerPoint n°{currentSlide}
            </span>
            <h2 className="text-xl font-extrabold text-white">
              {pptSlideTitle || `Texte soumis au vote sur la diapositive ${currentSlide}`}
            </h2>
            <p className="text-sm text-slate-300">
              Cliquez sur le bouton vert <strong>« VOTER CE SLIDE (OUI / NON / ABSTENTION) »</strong> en bas de l'écran pour ouvrir le scrutin sur les téléphones des participants.
            </p>
          </div>
        </div>
      )}

      {/* MODALE QR CODE GÉANTE */}
      {showQrModal && (
        <div
          onMouseEnter={() => setIsHoveringUi(true)}
          onMouseLeave={() => setIsHoveringUi(false)}
        >
          <QrCodeModalOverlay
            session={session}
            participants={participants}
            onClose={() => setShowQrModal(false)}
          />
        </div>
      )}

      {/* PANNEAU DE VOTE ACTIF (OUI / NON / ABSTENTION) PAR-DESSUS POWERPOINT */}
      {activeQuestion && (
        <div
          onMouseEnter={() => setIsHoveringUi(true)}
          onMouseLeave={() => setIsHoveringUi(false)}
        >
          <ActivePollOverlay
            session={session}
            question={activeQuestion}
            participants={participants}
            votes={votes}
            minimized={pollMinimized}
            onToggleMinimize={() => setPollMinimized((prev) => !prev)}
            onToggleOpenVote={handleToggleOpenVote}
            onToggleShowResults={handleToggleShowResults}
            onToggleRevealAnswer={() => {}}
            onClosePoll={handleCloseActivePoll}
          />
        </div>
      )}

      {/* BARRE DE VOTE FLOTTANTE EN BAS DE POWERPOINT */}
      <FloatingToolbar
        currentSlide={currentSlide}
        totalSlides={totalSlides || 10}
        participantsCount={participants.length}
        hasActiveVote={Boolean(activeQuestion)}
        pptConnected={pptConnected}
        pptInSlideShow={pptInSlideShow}
        slideTitle={pptSlideTitle}
        onPrevSlide={() => void handlePrevSlide()}
        onNextSlide={() => void handleNextSlide()}
        onOpenQrModal={() => setShowQrModal(true)}
        onLaunchResolutionVote={() => void handleLaunchResolutionVote()}
        onStartPptSlideShow={() => void handleStartPptSlideShow()}
        onExitPresentation={() => void handleExitPresentation()}
        onMouseEnterInteractive={() => setIsHoveringUi(true)}
        onMouseLeaveInteractive={() => setIsHoveringUi(false)}
      />
    </div>
  );
}
