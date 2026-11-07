import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  XCircle,
  MinusCircle,
  Radio,
  User,
  RefreshCw,
  LogOut,
  AlertCircle,
  Vote as VoteIcon,
  Send,
  Maximize2,
  X,
  ChevronRight,
} from 'lucide-react';
import { pollService } from '../services/pollService';
import type { Session, Question, Participant, Vote } from '../types/poll';

function getParticipantStorageKey(sessionId: string): string {
  return `pulseslide_participant_${sessionId}`;
}

export default function ParticipantJoinPage() {
  const { sessionCode } = useParams<{ sessionCode: string }>();
  const navigate = useNavigate();

  const [codeInput, setCodeInput] = useState(sessionCode?.toUpperCase() || '');
  const [nicknameInput, setNicknameInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [requiresPin, setRequiresPin] = useState(false);
  const [justAssignedPin, setJustAssignedPin] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [allQuestions, setAllQuestions] = useState<Question[]>([]);
  const [sessionVotes, setSessionVotes] = useState<Vote[]>([]);
  const [participant, setParticipant] = useState<Participant | null>(null);

  const questions = useMemo(
    () => allQuestions.filter((q) => q.title !== '__SLIDE_PREVIEW__'),
    [allQuestions]
  );

  // État du vote pour la diapositive active :
  // 1) draftChoice : choix pré-sélectionné par le votant avant d'appuyer sur "Valider"
  // 2) selectedAnswer & voteConfirmed : vote définitivement validé et verrouillé
  const [draftChoice, setDraftChoice] = useState<string>('');
  const [selectedAnswer, setSelectedAnswer] = useState<string>('');
  const [submittingVote, setSubmittingVote] = useState(false);
  const [voteConfirmed, setVoteConfirmed] = useState(false);

  // Aperçu de l'image de la diapositive PowerPoint en haut du GSM
  const [slideImgFailed, setSlideImgFailed] = useState(false);
  const [isSlideZoomed, setIsSlideZoomed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [dismissedQuestionId, setDismissedQuestionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('pulseslide_dismissed_q') || null;
    } catch {
      return null;
    }
  });

  const tryEnterFullscreen = () => {
    try {
      const docEl = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>;
      };
      if (!document.fullscreenElement) {
        if (docEl.requestFullscreen) {
          void docEl.requestFullscreen().catch(() => {});
        } else if (docEl.webkitRequestFullscreen) {
          void docEl.webkitRequestFullscreen();
        }
      }
    } catch {}
  };

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // 1. Chargement initial de la séance
  useEffect(() => {
    let cancelled = false;

    async function loadInitial() {
      if (!sessionCode) {
        setLoadingSession(false);
        return;
      }

      setLoadingSession(true);
      setError(null);

      try {
        const foundSession = await pollService.getSessionByCode(sessionCode);
        if (cancelled) return;

        if (!foundSession) {
          setError(`Aucune séance trouvée avec le code "${sessionCode.toUpperCase()}".`);
          setSession(null);
          setLoadingSession(false);
          return;
        }

        setSession(foundSession);

        const [sessionQuestions, initialVotes] = await Promise.all([
          pollService.getQuestionsBySession(foundSession.id),
          pollService.getVotesBySession(foundSession.id),
        ]);
        if (!cancelled) {
          setAllQuestions(sessionQuestions);
          setSessionVotes(initialVotes);
        }

        const savedParticipantId = localStorage.getItem(
          getParticipantStorageKey(foundSession.id)
        );
        if (savedParticipantId) {
          const existingParticipant = await pollService.getParticipantById(savedParticipantId);
          if (
            !cancelled &&
            existingParticipant &&
            existingParticipant.session_id === foundSession.id
          ) {
            setParticipant(existingParticipant);
            setNicknameInput(existingParticipant.nickname);
          } else {
            localStorage.removeItem(getParticipantStorageKey(foundSession.id));
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Erreur de connexion à la séance.');
        }
      } finally {
        if (!cancelled) setLoadingSession(false);
      }
    }

    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, [sessionCode]);

  // 2. Abonnement Temps Réel
  useEffect(() => {
    if (!session?.id) return;

    const unsubscribe = pollService.subscribeToSessionRealtime(session.id, {
      onSessionUpdate: (updatedSession) => setSession(updatedSession),
      onQuestionsChange: (updatedQuestions) => setAllQuestions(updatedQuestions),
      onVotesChange: (updatedVotes) => setSessionVotes(updatedVotes),
    });

    return () => unsubscribe();
  }, [session?.id]);

  const activeQuestion = useMemo(() => {
    if (session?.active_question_id) {
      const byActiveId = questions.find((q) => q.id === session.active_question_id);
      if (byActiveId) return byActiveId;
    }
    const openQ = questions.find((q) => q.is_open);
    if (openQ) return openQ;
    if (session?.show_results && questions.length > 0) {
      return questions[questions.length - 1];
    }
    return null;
  }, [session?.active_question_id, session?.show_results, questions]);

  const activeSlideNumber = activeQuestion?.slide_number || session?.current_slide || 1;

  const slideVoteStats = useMemo(() => {
    if (!activeQuestion) return null;
    const qVotes = sessionVotes.filter((v) => v.question_id === activeQuestion.id);
    const total = qVotes.length;
    let ouiCount = 0;
    let nonCount = 0;
    let abstCount = 0;
    for (const v of qVotes) {
      const ans = String(v.answer || '').trim().toUpperCase();
      if (ans === 'OUI' || ans === 'POUR') ouiCount++;
      else if (ans === 'NON' || ans === 'CONTRE') nonCount++;
      else abstCount++;
    }
    const ouiPct = total > 0 ? Math.round((ouiCount / total) * 100) : 0;
    const nonPct = total > 0 ? Math.round((nonCount / total) * 100) : 0;
    const abstPct = total > 0 ? Math.round((abstCount / total) * 100) : 0;
    const myVote = participant
      ? qVotes.find((v) => v.participant_id === participant.id)?.answer || null
      : null;
    return {
      question: activeQuestion,
      total,
      ouiCount,
      nonCount,
      abstCount,
      ouiPct,
      nonPct,
      abstPct,
      myVote,
    };
  }, [activeQuestion, sessionVotes, participant]);

  const handleWaitForNextVote = (questionId: string) => {
    tryEnterFullscreen();
    setDismissedQuestionId(questionId);
    setIsSlideZoomed(false);
    try {
      localStorage.setItem('pulseslide_dismissed_q', questionId);
    } catch {}
  };

  // Réinitialiser l'état d'erreur d'image quand la question active change
  useEffect(() => {
    setSlideImgFailed(false);
  }, [activeQuestion?.id, activeQuestion?.correct_option]);

  // 3. Charger le vote existant du participant lorsque le texte soumis au vote change
  useEffect(() => {
    let cancelled = false;

    async function loadExistingVote() {
      if (!activeQuestion || !participant) {
        setDraftChoice('');
        setSelectedAnswer('');
        setVoteConfirmed(false);
        return;
      }

      const existingVote = await pollService.getParticipantVoteForQuestion(
        activeQuestion.id,
        participant.id
      );
      if (cancelled) return;

      if (existingVote) {
        setDraftChoice(existingVote.answer);
        setSelectedAnswer(existingVote.answer);
        setVoteConfirmed(true);
      } else {
        setDraftChoice('');
        setSelectedAnswer('');
        setVoteConfirmed(false);
      }
    }

    void loadExistingVote();
    return () => {
      cancelled = true;
    };
  }, [activeQuestion?.id, participant?.id]);

  // Inscription rapide
  const handleJoinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    tryEnterFullscreen();
    setError(null);

    const targetCode = (sessionCode || codeInput).trim().toUpperCase();
    if (!targetCode) {
      setError('Veuillez saisir le code de la séance.');
      return;
    }

    if (!nicknameInput.trim()) {
      setError('Veuillez entrer votre nom ou prénom.');
      return;
    }

    setJoining(true);
    try {
      let currentSession = session;
      if (!currentSession || currentSession.code.toUpperCase() !== targetCode) {
        currentSession = await pollService.getSessionByCode(targetCode);
        if (!currentSession) {
          throw new Error(`Séance "${targetCode}" introuvable.`);
        }
        setSession(currentSession);
        const [qList, vList] = await Promise.all([
          pollService.getQuestionsBySession(currentSession.id),
          pollService.getVotesBySession(currentSession.id),
        ]);
        setAllQuestions(qList);
        setSessionVotes(vList);
      }

      const savedId = localStorage.getItem(getParticipantStorageKey(currentSession.id));
      const trimmedInput = nicknameInput.trim();
      const joined = await pollService.joinSession(
        currentSession.id,
        trimmedInput,
        savedId,
        pinInput.trim()
      );

      const assignedPin = pollService.extractParticipantPin(joined);
      if (!requiresPin && !/^\d{4}$/.test(trimmedInput) && savedId !== joined.id) {
        setJustAssignedPin(assignedPin);
      }
      setRequiresPin(false);
      setPinInput('');
      localStorage.setItem(getParticipantStorageKey(currentSession.id), joined.id);
      setParticipant(joined);

      if (sessionCode?.toUpperCase() !== targetCode) {
        navigate(`/join/${targetCode}`, { replace: true });
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'PIN_REQUIRED') {
        setRequiresPin(true);
        setError(
          'Ce nom est déjà inscrit dans cette séance. Saisissez votre code personnel à 4 chiffres pour reprendre votre accès.'
        );
      } else {
        setError(err instanceof Error ? err.message : 'Impossible de rejoindre la séance.');
      }
    } finally {
      setJoining(false);
    }
  };

  // Étape 1 : Sélectionner une option (sans encore l'envoyer)
  const handleSelectDraftChoice = (choice: string) => {
    tryEnterFullscreen();
    if (!activeQuestion || !activeQuestion.is_open || voteConfirmed || submittingVote) {
      return;
    }
    setDraftChoice(choice);
  };

  // Étape 2 : Valider et soumettre définitivement le vote
  const handleConfirmVote = async () => {
    if (
      !session ||
      !activeQuestion ||
      !participant ||
      !activeQuestion.is_open ||
      !draftChoice ||
      voteConfirmed
    ) {
      return;
    }

    setSubmittingVote(true);
    setError(null);
    try {
      const savedVote = await pollService.submitVote({
        session_id: session.id,
        question_id: activeQuestion.id,
        participant_id: participant.id,
        answer: draftChoice,
      });
      setSelectedAnswer(savedVote.answer);
      setVoteConfirmed(true);
      setSessionVotes((prev) => [
        ...prev.filter(
          (v) => !(v.question_id === activeQuestion.id && v.participant_id === participant.id)
        ),
        savedVote,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'envoi du vote.");
    } finally {
      setSubmittingVote(false);
    }
  };

  const handleLeaveParticipant = () => {
    if (session) {
      localStorage.removeItem(getParticipantStorageKey(session.id));
    }
    setParticipant(null);
    setNicknameInput('');
    setPinInput('');
    setRequiresPin(false);
    setJustAssignedPin(null);
    setError(null);
    setDraftChoice('');
    setSelectedAnswer('');
    setVoteConfirmed(false);
  };

  if (loadingSession) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6">
        <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin mb-3" />
        <p className="text-slate-300 font-medium">Connexion à la séance de vote...</p>
      </div>
    );
  }

  // ÉCRAN 1 : CONNEXION PARTICIPANT
  if (!participant || !session) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-indigo-950 text-white flex flex-col justify-center p-5">
        <div className="max-w-md w-full mx-auto bg-slate-900/90 border border-white/15 rounded-3xl p-6 sm:p-8 shadow-2xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-2xl bg-emerald-600 flex items-center justify-center shadow-lg">
              <VoteIcon className="w-6 h-6 text-white" />
            </div>
            <div>
              <span className="text-xs uppercase tracking-wider font-bold text-emerald-400">
                Vote en Direct
              </span>
              <h1 className="text-xl font-bold text-white">
                {session ? session.title : 'Rejoindre la séance'}
              </h1>
            </div>
          </div>

          {error && (
            <div className="mb-5 p-3.5 rounded-2xl bg-rose-500/15 border border-rose-500/40 text-rose-200 text-sm flex items-start gap-2.5">
              <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleJoinSubmit} className="space-y-4">
            {!session && (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  Code de la séance
                </label>
                <input
                  type="text"
                  maxLength={8}
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                  placeholder="Ex: AB12CD"
                  className="w-full px-4 py-3.5 rounded-2xl bg-slate-950 border border-white/15 text-white font-mono text-lg tracking-widest uppercase focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  required
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                Votre Nom et Prénom (ou votre code à 4 chiffres)
              </label>
              <div className="relative">
                <User className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  maxLength={40}
                  value={nicknameInput}
                  onChange={(e) => {
                    setNicknameInput(e.target.value);
                    if (requiresPin) {
                      setRequiresPin(false);
                      setPinInput('');
                      setError(null);
                    }
                  }}
                  placeholder="Ex: Jean Dupont ou 4829"
                  autoFocus
                  className="w-full pl-12 pr-4 py-4 rounded-2xl bg-slate-950 border border-white/15 text-white text-base font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  required
                />
              </div>
              <p className="text-xs text-slate-400 mt-1.5">
                À votre 1re connexion, un <strong>code personnel à 4 chiffres</strong> vous sera attribué pour garantir un vote unique.
              </p>
            </div>

            {requiresPin && (
              <div className="p-4 rounded-2xl bg-amber-500/15 border border-amber-400/50 space-y-2">
                <label className="block text-xs font-extrabold uppercase tracking-wider text-amber-300">
                  Votre code personnel à 4 chiffres
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{4}"
                  maxLength={4}
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="Ex: 4829"
                  autoFocus
                  className="w-full px-4 py-3.5 rounded-xl bg-slate-950 border border-amber-400/50 text-white font-mono text-2xl font-black tracking-[0.35em] text-center focus:outline-none focus:ring-2 focus:ring-amber-400"
                  required
                />
              </div>
            )}

            <button
              type="submit"
              disabled={joining}
              className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.99] text-white font-bold text-base shadow-lg transition flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {joining
                ? 'Vérification...'
                : requiresPin
                ? 'Valider mon code à 4 chiffres'
                : 'Accéder au vote'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Options de vote : par défaut OUI / NON / ABSTENTION
  const choices =
    activeQuestion && activeQuestion.options.length > 0
      ? activeQuestion.options
      : ['OUI', 'NON', 'ABSTENTION'];

  const baseUrl = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
  const slideImageUrl = activeQuestion?.correct_option?.startsWith('data:image/')
    ? activeQuestion.correct_option
    : `${baseUrl}slides/slide-${activeSlideNumber}.png?v=20261106g`;

  const participantBaseName = pollService.extractParticipantBaseName(participant.nickname);
  const participantPin = pollService.extractParticipantPin(participant);

  const isVotingOpen = Boolean(activeQuestion && activeQuestion.is_open);
  const isShowingClosedResult = Boolean(
    activeQuestion &&
      !activeQuestion.is_open &&
      slideVoteStats &&
      dismissedQuestionId !== activeQuestion.id
  );

  // ÉCRAN 2 : CONNECTÉ — 3 ÉTATS : (1) VOTE EN COURS, (2) RÉSULTAT AFFICHÉ, (3) EN ATTENTE DU VOTE SUIVANT
  return (
    <div
      onClick={() => {
        if (!isFullscreen) tryEnterFullscreen();
      }}
      className="min-h-[100dvh] bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white flex flex-col justify-between"
    >
      {/* Modale d'attribution du code personnel à 4 chiffres à la 1re connexion */}
      {justAssignedPin && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setJustAssignedPin(null)}
        >
          <div
            className="max-w-sm w-full bg-slate-900 border-2 border-indigo-400/60 rounded-3xl p-6 text-center shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="inline-flex px-3 py-1 rounded-full bg-indigo-500/20 border border-indigo-400/40 text-indigo-300 text-xs font-extrabold uppercase tracking-wider">
              Identification sécurisée
            </div>
            <h2 className="text-lg font-extrabold text-white">
              Bienvenue, {participantBaseName}
            </h2>
            <p className="text-xs text-slate-300 leading-relaxed">
              Voici votre <strong>numéro personnel à 4 chiffres</strong> pour toute la séance :
            </p>
            <div className="py-4 px-6 rounded-2xl bg-slate-950 border-2 border-emerald-400/70 font-mono text-4xl font-black tracking-[0.35em] text-emerald-400 shadow-inner">
              {justAssignedPin}
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Ce code garantit un vote unique et vous permet de reprendre votre session si vous prêtez votre GSM à un collègue.
            </p>
            <button
              type="button"
              onClick={() => {
                tryEnterFullscreen();
                setJustAssignedPin(null);
              }}
              className="w-full py-3.5 px-4 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-sm shadow-lg transition"
            >
              J'ai noté mon code ({justAssignedPin}) — Continuer
            </button>
          </div>
        </div>
      )}

      {/* Modale plein écran pour zoomer sur la diapositive du vote */}
      {isSlideZoomed && !slideImgFailed && (isVotingOpen || isShowingClosedResult) && (
        <div
          className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center p-3"
          onClick={() => setIsSlideZoomed(false)}
        >
          <div
            className="w-full max-w-3xl flex items-center justify-between mb-3 px-1 gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-xl bg-indigo-500/30 text-indigo-200 border border-indigo-400/30">
              Diapositive du scrutin
            </span>
            <button
              type="button"
              onClick={() => setIsSlideZoomed(false)}
              className="px-3 py-1.5 rounded-xl bg-slate-800 text-white text-xs font-bold flex items-center gap-1.5 border border-white/15"
            >
              <X className="w-4 h-4" />
              Fermer
            </button>
          </div>
          <img
            src={slideImageUrl}
            alt="Diapositive du vote"
            className="w-full max-w-3xl rounded-2xl border border-white/20 shadow-2xl bg-white object-contain"
          />
          <p className="text-xs text-slate-400 mt-3">
            Touchez l'écran pour revenir au scrutin
          </p>
        </div>
      )}

      <main className="flex-1 flex flex-col justify-center p-2.5 sm:p-4 max-w-md w-full mx-auto">
        {isVotingOpen && activeQuestion ? (
          /* ÉTAT 1 : SCRUTIN OUVERT — AFFICHAGE COMPACT SUR 1 SEUL ÉCRAN (DIA + OUI / NON / ABSTENTION + VALIDER) */
          <div className="space-y-2.5 my-auto">
            <div className="bg-slate-900 border border-white/15 rounded-2xl p-2.5 shadow-xl space-y-2">
              <div className="flex items-center justify-between gap-1.5 px-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping shrink-0" />
                  <span className="text-xs font-bold text-white truncate">
                    {participantBaseName}
                  </span>
                  <span className="px-1.5 py-0.5 rounded-md bg-indigo-500/30 border border-indigo-400/40 text-indigo-200 font-mono text-xs font-black shrink-0">
                    #{participantPin}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!isFullscreen && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        tryEnterFullscreen();
                      }}
                      className="text-xs font-bold text-emerald-300 bg-emerald-500/20 px-2 py-1 rounded-lg border border-emerald-500/40 inline-flex items-center gap-1"
                    >
                      <Maximize2 className="w-3 h-3" />
                      Plein écran
                    </button>
                  )}
                  {!slideImgFailed && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        tryEnterFullscreen();
                        setIsSlideZoomed(true);
                      }}
                      className="text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 px-2 py-1 rounded-lg border border-white/10 inline-flex items-center gap-1"
                    >
                      <Maximize2 className="w-3 h-3 text-indigo-400" />
                      Loupe
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleLeaveParticipant();
                    }}
                    title="Prêter ce GSM / Changer de votant"
                    className="text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 px-2 py-1 rounded-lg border border-white/10 inline-flex items-center gap-1"
                  >
                    <LogOut className="w-3 h-3 text-amber-400" />
                    Prêter
                  </button>
                </div>
              </div>

              {!slideImgFailed && (
                <div
                  onClick={() => setIsSlideZoomed(true)}
                  className="relative rounded-xl overflow-hidden border border-white/20 bg-white shadow-md cursor-zoom-in flex items-center justify-center"
                >
                  <img
                    src={slideImageUrl}
                    alt="Diapositive soumise au vote"
                    onError={() => setSlideImgFailed(true)}
                    className="w-full max-h-[28dvh] h-auto block object-contain mx-auto"
                  />
                </div>
              )}

              <h2 className="text-xs sm:text-sm font-extrabold text-white leading-snug px-1 line-clamp-2">
                {activeQuestion.title}
              </h2>
            </div>

            {error && (
              <div className="p-2.5 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-200 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-2">
              {choices.map((option) => {
                const upper = option.trim().toUpperCase();
                const currentHighlighted = voteConfirmed ? selectedAnswer : draftChoice;
                const isSelected = currentHighlighted === option;

                let btnStyle =
                  'from-slate-700 to-slate-800 hover:from-slate-600 hover:to-slate-700 border-slate-500/40';
                let IconComponent = MinusCircle;

                if (upper === 'OUI' || upper === 'POUR') {
                  btnStyle =
                    'from-emerald-600 to-teal-700 hover:from-emerald-500 hover:to-teal-600 border-emerald-400/50';
                  IconComponent = CheckCircle2;
                } else if (upper === 'NON' || upper === 'CONTRE') {
                  btnStyle =
                    'from-rose-600 to-red-700 hover:from-rose-500 hover:to-red-600 border-rose-400/50';
                  IconComponent = XCircle;
                }

                const isDisabled = voteConfirmed || submittingVote;

                return (
                  <button
                    key={option}
                    type="button"
                    disabled={isDisabled}
                    onClick={() => handleSelectDraftChoice(option)}
                    className={`w-full py-3 px-4 rounded-2xl bg-gradient-to-r ${btnStyle} border-2 transition-all active:scale-[0.98] shadow-lg flex items-center justify-between ${
                      isSelected
                        ? 'ring-4 ring-white border-white scale-[1.01] opacity-100'
                        : voteConfirmed
                        ? 'opacity-40'
                        : 'opacity-90 hover:opacity-100'
                    } ${isDisabled ? 'cursor-not-allowed' : ''}`}
                  >
                    <div className="flex items-center gap-3">
                      <IconComponent className="w-6 h-6 text-white shrink-0" />
                      <span className="text-lg sm:text-xl font-black tracking-wide text-white uppercase">
                        {option}
                      </span>
                    </div>

                    {isSelected && (
                      <span className="px-2.5 py-0.5 rounded-full bg-white text-slate-950 text-xs font-extrabold uppercase">
                        {voteConfirmed ? 'Validé' : 'Sélectionné'}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="pt-0.5">
              {voteConfirmed && selectedAnswer ? (
                <div className="p-3 rounded-2xl bg-emerald-500/20 border-2 border-emerald-400/60 flex items-center gap-3 shadow-lg">
                  <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
                  <div>
                    <p className="text-sm font-extrabold text-white">
                      Vote enregistré : {selectedAnswer}
                    </p>
                    <p className="text-xs text-emerald-200/90">
                      En attente de la clôture du vote pour afficher le résultat...
                    </p>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={!draftChoice || submittingVote}
                  onClick={handleConfirmVote}
                  className={`w-full py-3.5 px-4 rounded-2xl font-extrabold text-sm sm:text-base shadow-2xl transition-all flex items-center justify-center gap-2 ${
                    draftChoice
                      ? 'bg-gradient-to-r from-indigo-500 via-indigo-600 to-violet-600 hover:from-indigo-400 hover:to-violet-500 text-white ring-2 ring-white/80 active:scale-[0.98]'
                      : 'bg-slate-800/80 border border-white/15 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  <Send className="w-4 h-4 shrink-0" />
                  <span>
                    {submittingVote
                      ? 'Enregistrement en cours...'
                      : draftChoice
                      ? `Valider mon vote (${draftChoice})`
                      : '1. Choisissez OUI / NON / ABSTENTION puis validez'}
                  </span>
                </button>
              )}
            </div>
          </div>
        ) : isShowingClosedResult && slideVoteStats ? (
          /* ÉTAT 2 : VOTE TERMINÉ — AFFICHAGE DU RÉSULTAT + BOUTON POUR SE METTRE EN ATTENTE DU VOTE SUIVANT */
          <div className="bg-slate-900/90 border border-white/15 rounded-3xl p-4 shadow-2xl my-auto space-y-3">
            {(slideVoteStats.myVote || selectedAnswer) && (
              <div className="py-2 px-3 rounded-xl bg-emerald-500/20 border border-emerald-400/50 flex items-center justify-center gap-2 shadow-md">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="text-xs sm:text-sm font-extrabold text-emerald-100">
                  Votre vote : {slideVoteStats.myVote || selectedAnswer}
                </span>
              </div>
            )}

            {!slideImgFailed && (
              <div
                onClick={() => setIsSlideZoomed(true)}
                className="relative rounded-xl overflow-hidden border border-white/15 bg-white shadow-lg cursor-zoom-in flex items-center justify-center"
              >
                <img
                  src={slideImageUrl}
                  alt="Diapositive votée"
                  onError={() => setSlideImgFailed(true)}
                  className="w-full max-h-[25dvh] h-auto block object-contain mx-auto"
                />
              </div>
            )}

            <div className="bg-slate-950/90 border border-indigo-400/30 rounded-2xl p-3.5 text-left space-y-2.5 shadow-lg">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-extrabold uppercase tracking-wider text-indigo-300">
                  Résultat du vote
                </span>
                <span className="text-xs font-semibold text-slate-400">
                  {slideVoteStats.total} vote(s)
                </span>
              </div>
              <p className="text-xs sm:text-sm font-bold text-white leading-snug line-clamp-2">
                {slideVoteStats.question.title}
              </p>

              <div
                className={`py-2 px-3 rounded-xl text-center text-xs sm:text-sm font-black uppercase tracking-wide text-white ${
                  slideVoteStats.ouiCount > slideVoteStats.nonCount
                    ? 'bg-emerald-600'
                    : slideVoteStats.nonCount > slideVoteStats.ouiCount
                    ? 'bg-rose-600'
                    : 'bg-amber-600'
                }`}
              >
                {slideVoteStats.ouiCount > slideVoteStats.nonCount
                  ? `Proposition adoptée (OUI : ${slideVoteStats.ouiPct} %)`
                  : slideVoteStats.nonCount > slideVoteStats.ouiCount
                  ? `Proposition rejetée (NON : ${slideVoteStats.nonPct} %)`
                  : `Égalité des voix (OUI : ${slideVoteStats.ouiPct} % | NON : ${slideVoteStats.nonPct} %)`}
              </div>

              <div className="space-y-2 pt-0.5">
                {[
                  {
                    label: 'OUI',
                    count: slideVoteStats.ouiCount,
                    pct: slideVoteStats.ouiPct,
                    barClass: 'bg-emerald-500',
                    badgeClass: 'bg-emerald-600 text-white',
                  },
                  {
                    label: 'NON',
                    count: slideVoteStats.nonCount,
                    pct: slideVoteStats.nonPct,
                    barClass: 'bg-rose-500',
                    badgeClass: 'bg-rose-600 text-white',
                  },
                  {
                    label: 'ABSTENTION',
                    count: slideVoteStats.abstCount,
                    pct: slideVoteStats.abstPct,
                    barClass: 'bg-sky-500',
                    badgeClass: 'bg-sky-600 text-white',
                  },
                ].map((row) => (
                  <div key={row.label} className="space-y-1">
                    <div className="flex items-center justify-between text-xs font-bold">
                      <span className={`px-2 py-0.5 rounded-md ${row.badgeClass}`}>
                        {row.label}
                      </span>
                      <span className="text-slate-200">
                        {row.count} voix ({row.pct} %)
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${row.barClass} transition-all duration-300`}
                        style={{ width: `${Math.max(row.pct, 4)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleWaitForNextVote(slideVoteStats.question.id)}
              className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-indigo-500 via-indigo-600 to-violet-600 hover:from-indigo-400 hover:to-violet-500 active:scale-[0.98] text-white font-extrabold text-sm sm:text-base shadow-xl transition flex items-center justify-center gap-2 ring-2 ring-white/40"
            >
              <span>Se mettre en attente pour le vote suivant</span>
              <ChevronRight className="w-5 h-5 shrink-0" />
            </button>
          </div>
        ) : (
          /* ÉTAT 3 : EN ATTENTE DU VOTE SUIVANT (AUCUNE DIAPOSITIVE AFFICHÉE HORS SCRUTIN) */
          <div className="bg-slate-900/80 border border-white/10 rounded-3xl p-6 text-center shadow-2xl my-auto space-y-4">
            <div className="flex items-center justify-between text-xs text-slate-400 pb-2 border-b border-white/10 gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-bold text-white truncate">{participantBaseName}</span>
                <span className="px-2 py-0.5 rounded-md bg-indigo-500/30 border border-indigo-400/40 text-indigo-200 font-mono font-black shrink-0">
                  Code #{participantPin}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {!isFullscreen && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      tryEnterFullscreen();
                    }}
                    className="px-2 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold inline-flex items-center gap-1"
                  >
                    <Maximize2 className="w-3 h-3" />
                    Plein écran
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleLeaveParticipant}
                  title="Prêter ce GSM / Changer de votant"
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-white/10 font-semibold inline-flex items-center gap-1 transition"
                >
                  <LogOut className="w-3.5 h-3.5 text-amber-400" />
                  Prêter GSM
                </button>
              </div>
            </div>
            <div className="w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center mx-auto">
              <Radio className="w-7 h-7 text-emerald-400 animate-pulse" />
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-white">
              En attente pour le vote suivant
            </h2>
            <p className="text-slate-300 text-sm leading-relaxed">
              Dès que l'orateur lance le prochain scrutin dans PowerPoint, la{' '}
              <strong>diapositive</strong> et les boutons{' '}
              <strong>OUI / NON / ABSTENTION</strong> s'afficheront ici automatiquement.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
