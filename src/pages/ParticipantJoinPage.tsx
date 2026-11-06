import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  XCircle,
  MinusCircle,
  Radio,
  User,
  Lock,
  RefreshCw,
  LogOut,
  Layers,
  AlertCircle,
  Vote as VoteIcon,
  Send,
  Maximize2,
  X,
  ChevronLeft,
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
  const [loadingSession, setLoadingSession] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [sessionVotes, setSessionVotes] = useState<Vote[]>([]);
  const [participant, setParticipant] = useState<Participant | null>(null);

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
  const [manualSlideNumber, setManualSlideNumber] = useState<number | null>(null);

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
          setQuestions(sessionQuestions);
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
      onQuestionsChange: (updatedQuestions) => setQuestions(updatedQuestions),
      onVotesChange: (updatedVotes) => setSessionVotes(updatedVotes),
    });

    return () => unsubscribe();
  }, [session?.id]);

  const activeQuestion = useMemo(() => {
    if (!session?.active_question_id) return null;
    return questions.find((q) => q.id === session.active_question_id) ?? null;
  }, [session?.active_question_id, questions]);

  const liveSlideNumber =
    (activeQuestion?.is_open ? activeQuestion.slide_number : null) ||
    session?.current_slide ||
    1;

  // Quand PowerPoint change de diapositive ou qu'un vote s'ouvre, suivre automatiquement le direct
  useEffect(() => {
    setManualSlideNumber(null);
  }, [liveSlideNumber, activeQuestion?.id, activeQuestion?.is_open]);

  const activeSlideNumber = manualSlideNumber ?? liveSlideNumber;

  // Question associée à la diapositive affichée (ex: Dia 9 de vote ou Dia 10 de résultat)
  const slideQuestion = useMemo(() => {
    const reversed = [...questions].reverse();
    const exactMatch = reversed.find((q) => q.slide_number === activeSlideNumber);
    if (exactMatch) return exactMatch;
    const resultSlideMatch = reversed.find(
      (q) => !q.is_open && q.slide_number + 1 === activeSlideNumber
    );
    return resultSlideMatch ?? null;
  }, [questions, activeSlideNumber]);

  const slideVoteStats = useMemo(() => {
    if (!slideQuestion) return null;
    const qVotes = sessionVotes.filter((v) => v.question_id === slideQuestion.id);
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
      question: slideQuestion,
      total,
      ouiCount,
      nonCount,
      abstCount,
      ouiPct,
      nonPct,
      abstPct,
      myVote,
    };
  }, [slideQuestion, sessionVotes, participant]);

  const handlePrevViewedSlide = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setManualSlideNumber(Math.max(1, activeSlideNumber - 1));
  };

  const handleNextViewedSlide = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setManualSlideNumber(activeSlideNumber + 1);
  };

  const handleReturnToLiveSlide = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setManualSlideNumber(null);
  };

  // Réinitialiser l'état d'erreur d'image quand on change de slide
  useEffect(() => {
    setSlideImgFailed(false);
  }, [activeSlideNumber, activeQuestion?.id, activeQuestion?.correct_option, slideQuestion?.id]);

  // 3. Charger le vote existant du participant lorsque le texte soumis au vote change
  useEffect(() => {
    let cancelled = false;

    async function loadExistingVote() {
      const targetQ = activeQuestion || slideQuestion;
      if (!targetQ || !participant) {
        setDraftChoice('');
        setSelectedAnswer('');
        setVoteConfirmed(false);
        return;
      }

      const existingVote = await pollService.getParticipantVoteForQuestion(
        targetQ.id,
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
  }, [activeQuestion?.id, slideQuestion?.id, participant?.id]);

  // Inscription rapide
  const handleJoinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
        setQuestions(qList);
        setSessionVotes(vList);
      }

      const savedId = localStorage.getItem(getParticipantStorageKey(currentSession.id));
      const joined = await pollService.joinSession(
        currentSession.id,
        nicknameInput.trim(),
        savedId
      );

      localStorage.setItem(getParticipantStorageKey(currentSession.id), joined.id);
      setParticipant(joined);

      if (sessionCode?.toUpperCase() !== targetCode) {
        navigate(`/join/${targetCode}`, { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible de rejoindre la séance.');
    } finally {
      setJoining(false);
    }
  };

  // Étape 1 : Sélectionner une option (sans encore l'envoyer)
  const handleSelectDraftChoice = (choice: string) => {
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
                Votre Nom et Prénom
              </label>
              <div className="relative">
                <User className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  maxLength={40}
                  value={nicknameInput}
                  onChange={(e) => setNicknameInput(e.target.value)}
                  placeholder="Ex: Jean Dupont"
                  autoFocus
                  className="w-full pl-12 pr-4 py-4 rounded-2xl bg-slate-950 border border-white/15 text-white text-base font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={joining}
              className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.99] text-white font-bold text-base shadow-lg transition flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {joining ? 'Connexion...' : 'Accéder au vote'}
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
  const liveOrSlideQuestion =
    activeQuestion && activeSlideNumber === activeQuestion.slide_number
      ? activeQuestion
      : slideQuestion && activeSlideNumber === slideQuestion.slide_number
      ? slideQuestion
      : null;
  const slideImageUrl =
    liveOrSlideQuestion?.correct_option?.startsWith('data:image/')
      ? liveOrSlideQuestion.correct_option
      : `${baseUrl}slides/slide-${activeSlideNumber}.png?v=20261106c`;

  // ÉCRAN 2 : CONNECTÉ — ATTENTE OU VOTE OUI / NON / ABSTENTION
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white flex flex-col">
      {/* Modale plein écran pour zoomer sur la diapositive PowerPoint */}
      {isSlideZoomed && !slideImgFailed && (
        <div
          className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center p-3"
          onClick={() => setIsSlideZoomed(false)}
        >
          <div
            className="w-full max-w-3xl flex items-center justify-between mb-3 px-1 gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handlePrevViewedSlide}
                disabled={activeSlideNumber <= 1}
                className="px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1 border border-white/15"
              >
                <ChevronLeft className="w-4 h-4" />
                Préc.
              </button>
              <span className="text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-xl bg-indigo-500/30 text-indigo-200 border border-indigo-400/30">
                Dia {activeSlideNumber}
              </span>
              <button
                type="button"
                onClick={handleNextViewedSlide}
                className="px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1 border border-white/15"
              >
                Suiv.
                <ChevronRight className="w-4 h-4" />
              </button>
              {activeSlideNumber !== liveSlideNumber && (
                <button
                  type="button"
                  onClick={handleReturnToLiveSlide}
                  className="px-2.5 py-1.5 rounded-xl bg-emerald-600 text-white text-xs font-bold"
                >
                  Direct ({liveSlideNumber})
                </button>
              )}
            </div>
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
            alt={`Diapositive ${activeSlideNumber}`}
            className="w-full max-w-3xl rounded-2xl border border-white/20 shadow-2xl bg-white object-contain"
          />
          <p className="text-xs text-slate-400 mt-3">
            Utilisez ◀ Préc. / Suiv. ▶ pour parcourir les diapositives ou touchez l'écran pour revenir au vote
          </p>
        </div>
      )}

      {/* Barre supérieure */}
      <header className="px-4 py-3 bg-slate-900/90 border-b border-white/10 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse shrink-0" />
          <div className="truncate">
            <p className="text-xs text-slate-400 truncate">{session.title}</p>
            <p className="text-sm font-bold text-white truncate">{participant.nickname}</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handlePrevViewedSlide}
            disabled={activeSlideNumber <= 1}
            title="Diapositive précédente"
            className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-white/10 text-slate-200 transition"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="px-2.5 py-1 rounded-xl bg-slate-800 border border-white/10 text-xs font-semibold text-slate-300 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-emerald-400" />
            <span>Dia {activeSlideNumber}</span>
          </div>
          <button
            type="button"
            onClick={handleNextViewedSlide}
            title="Diapositive suivante"
            className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 text-slate-200 transition"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={handleLeaveParticipant}
            title="Changer de participant"
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col justify-start p-4 sm:p-5 max-w-md w-full mx-auto">
        {!activeQuestion || !activeQuestion.is_open || voteConfirmed ? (
          /* ÉCRAN D'ATTENTE DU VOTE SUIVANT (affiché avant l'ouverture ET dès que le vote définitif est validé) */
          <div className="bg-slate-900/80 border border-white/10 rounded-3xl p-5 text-center shadow-2xl my-auto space-y-4">
            {(voteConfirmed && selectedAnswer) || slideVoteStats?.myVote ? (
              <div className="p-3 rounded-2xl bg-emerald-500/20 border border-emerald-400/50 flex items-center justify-center gap-2.5 shadow-md">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <span className="text-sm font-extrabold text-emerald-100">
                  Vote définitif validé : {slideVoteStats?.myVote || selectedAnswer}
                </span>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={handlePrevViewedSlide}
                disabled={activeSlideNumber <= 1}
                className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-bold text-slate-200 border border-white/10 inline-flex items-center gap-1"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Dia préc.
              </button>
              <span className="text-xs font-bold text-indigo-300">
                Diapositive {activeSlideNumber}
                {activeSlideNumber !== liveSlideNumber ? ` (Direct : ${liveSlideNumber})` : ''}
              </span>
              <button
                type="button"
                onClick={handleNextViewedSlide}
                className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 border border-white/10 inline-flex items-center gap-1"
              >
                Dia suiv.
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
            {activeSlideNumber !== liveSlideNumber && (
              <button
                type="button"
                onClick={handleReturnToLiveSlide}
                className="w-full py-1.5 rounded-xl bg-emerald-600/30 border border-emerald-400/40 text-emerald-200 text-xs font-bold"
              >
                Revenir à la diapositive en direct (Dia {liveSlideNumber})
              </button>
            )}
            {!slideImgFailed && (
              <div
                onClick={() => setIsSlideZoomed(true)}
                className="relative rounded-2xl overflow-hidden border border-white/15 bg-white shadow-lg cursor-zoom-in"
              >
                <img
                  src={slideImageUrl}
                  alt={`Slide ${activeSlideNumber}`}
                  onError={() => setSlideImgFailed(true)}
                  className="w-full h-auto block object-contain"
                />
              </div>
            )}

            {/* RÉSULTAT DU VOTE POUR CETTE DIAPOSITIVE (OU SA DIAPO DE RÉSULTAT) */}
            {slideVoteStats && (
              <div className="bg-slate-950/90 border border-indigo-400/30 rounded-2xl p-4 text-left space-y-3 shadow-lg">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-extrabold uppercase tracking-wider text-indigo-300">
                    Résultat du vote — Dia {slideVoteStats.question.slide_number}
                  </span>
                  <span className="text-xs font-semibold text-slate-400">
                    {slideVoteStats.total} vote(s)
                  </span>
                </div>
                <p className="text-sm font-bold text-white leading-snug">
                  {slideVoteStats.question.title}
                </p>

                {/* Bandeau Verdict */}
                <div
                  className={`py-2 px-3 rounded-xl text-center text-xs font-black uppercase tracking-wide text-white ${
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

                {/* Barres OUI / NON / ABSTENTION */}
                <div className="space-y-2 pt-1">
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
                      <div className="w-full h-2.5 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${row.barClass} transition-all duration-300`}
                          style={{ width: `${Math.max(row.pct, 4)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Accès rapide aux diapositives votées */}
            {questions.length > 0 && (
              <div className="pt-1 text-left space-y-1.5">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400 px-1">
                  Votes réalisés ({questions.length}) :
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {questions.map((q) => {
                    const isViewingThis =
                      activeSlideNumber === q.slide_number ||
                      (!q.is_open && activeSlideNumber === q.slide_number + 1);
                    return (
                      <button
                        key={q.id}
                        type="button"
                        onClick={() => setManualSlideNumber(q.slide_number)}
                        className={`px-2.5 py-1.5 rounded-xl text-xs font-bold border transition ${
                          isViewingThis
                            ? 'bg-indigo-600 border-indigo-400 text-white'
                            : 'bg-slate-800/90 hover:bg-slate-700 border-white/10 text-slate-200'
                        }`}
                      >
                        Dia {q.slide_number} {q.is_open ? '• En cours' : '• Résultat'}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {!slideVoteStats && (
              <>
                <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center mx-auto">
                  <Radio className="w-6 h-6 text-emerald-400 animate-pulse" />
                </div>
                <h2 className="text-lg font-bold text-white">
                  {voteConfirmed ? 'En attente du vote suivant...' : 'Vous êtes prêt à voter'}
                </h2>
                <p className="text-slate-300 text-sm leading-relaxed">
                  {voteConfirmed ? (
                    <>
                      Votre vote a bien été enregistré. Dès que l'orateur lancera le{' '}
                      <strong>prochain vote</strong>, les boutons s'afficheront ici automatiquement.
                    </>
                  ) : (
                    <>
                      Dès que l'orateur ouvre le vote sur une diapositive, les boutons{' '}
                      <strong>OUI / NON / ABSTENTION</strong> s'afficheront ici automatiquement.
                    </>
                  )}
                </p>
              </>
            )}
          </div>
        ) : (
          /* ÉCRAN DE VOTE : SLIDE EN HAUT + OUI / NON / ABSTENTION + BOUTON VALIDER EN BAS */
          <div className="space-y-4">
            {/* 1. EN HAUT : VISUEL DE LA DIAPOSITIVE POWERPOINT SUR LAQUELLE ON VOTE */}
            <div className="bg-slate-900 border border-white/15 rounded-3xl p-3.5 shadow-xl space-y-2.5">
              <div className="flex items-center justify-between gap-1.5 px-1 flex-wrap">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handlePrevViewedSlide}
                    disabled={activeSlideNumber <= 1}
                    className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-bold text-slate-200 border border-white/10 inline-flex items-center gap-0.5"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    Préc.
                  </button>
                  <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    Dia {activeSlideNumber}
                  </span>
                  <button
                    type="button"
                    onClick={handleNextViewedSlide}
                    className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 border border-white/10 inline-flex items-center gap-0.5"
                  >
                    Suiv.
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {activeSlideNumber !== liveSlideNumber && (
                    <button
                      type="button"
                      onClick={handleReturnToLiveSlide}
                      className="text-xs font-bold text-emerald-300 bg-emerald-500/20 px-2 py-1 rounded-lg border border-emerald-500/30"
                    >
                      Direct ({liveSlideNumber})
                    </button>
                  )}
                  {!slideImgFailed && (
                    <button
                      type="button"
                      onClick={() => setIsSlideZoomed(true)}
                      className="text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 px-2.5 py-1 rounded-lg border border-white/10 inline-flex items-center gap-1"
                    >
                      <Maximize2 className="w-3 h-3 text-indigo-400" />
                      Agrandir
                    </button>
                  )}

                  {activeQuestion.is_open ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-400">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                      Scrutin ouvert
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-400">
                      <Lock className="w-3.5 h-3.5" />
                      Scrutin clôturé
                    </span>
                  )}
                </div>
              </div>

              {/* Miniature de la vraie slide PowerPoint */}
              {!slideImgFailed && (
                <div
                  onClick={() => setIsSlideZoomed(true)}
                  className="relative rounded-2xl overflow-hidden border border-white/20 bg-white shadow-md cursor-zoom-in group"
                >
                  <img
                    src={slideImageUrl}
                    alt={`Slide ${activeSlideNumber}`}
                    onError={() => setSlideImgFailed(true)}
                    className="w-full h-auto block object-contain"
                  />
                </div>
              )}

              <h2 className="text-sm sm:text-base font-extrabold text-white leading-snug px-1">
                {activeQuestion.title}
              </h2>
            </div>

            {error && (
              <div className="p-3 rounded-2xl bg-rose-500/15 border border-rose-500/40 text-rose-200 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* 2. LES 3 BOUTONS DE CHOIX : OUI / NON / ABSTENTION */}
            <div className="space-y-2.5">
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

                const isDisabled = !activeQuestion.is_open || voteConfirmed || submittingVote;

                return (
                  <button
                    key={option}
                    type="button"
                    disabled={isDisabled}
                    onClick={() => handleSelectDraftChoice(option)}
                    className={`w-full p-4 sm:p-5 rounded-2xl bg-gradient-to-r ${btnStyle} border-2 transition-all active:scale-[0.98] shadow-xl flex items-center justify-between ${
                      isSelected
                        ? 'ring-4 ring-white border-white scale-[1.01] opacity-100'
                        : voteConfirmed
                        ? 'opacity-40'
                        : 'opacity-85 hover:opacity-100'
                    } ${isDisabled ? 'cursor-not-allowed' : ''}`}
                  >
                    <div className="flex items-center gap-3.5">
                      <IconComponent className="w-7 h-7 text-white shrink-0" />
                      <span className="text-xl sm:text-2xl font-black tracking-wide text-white uppercase">
                        {option}
                      </span>
                    </div>

                    {isSelected && (
                      <span className="px-3 py-1 rounded-full bg-white text-slate-950 text-xs font-extrabold uppercase">
                        {voteConfirmed ? 'Validé' : 'Sélectionné'}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 3. EN BAS : BOUTON "VALIDER MON VOTE" (OU CONFIRMATION DÉFINITIVE VERROUILLÉE) */}
            <div className="pt-1 pb-4">
              {voteConfirmed && selectedAnswer ? (
                <div className="p-4 rounded-2xl bg-emerald-500/20 border-2 border-emerald-400/60 flex items-center gap-3 shadow-lg">
                  <CheckCircle2 className="w-7 h-7 text-emerald-400 shrink-0" />
                  <div>
                    <p className="text-sm sm:text-base font-extrabold text-white">
                      Vote définitif enregistré : {selectedAnswer}
                    </p>
                    <p className="text-xs text-emerald-200/90">
                      Votre vote est verrouillé pour cette diapositive.
                    </p>
                  </div>
                </div>
              ) : activeQuestion.is_open ? (
                <button
                  type="button"
                  disabled={!draftChoice || submittingVote}
                  onClick={handleConfirmVote}
                  className={`w-full py-4 px-5 rounded-2xl font-extrabold text-base sm:text-lg shadow-2xl transition-all flex items-center justify-center gap-2.5 ${
                    draftChoice
                      ? 'bg-gradient-to-r from-indigo-500 via-indigo-600 to-violet-600 hover:from-indigo-400 hover:to-violet-500 text-white ring-2 ring-white/80 active:scale-[0.98]'
                      : 'bg-slate-800/80 border border-white/15 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  <Send className="w-5 h-5 shrink-0" />
                  <span>
                    {submittingVote
                      ? 'Enregistrement en cours...'
                      : draftChoice
                      ? `Valider mon vote (${draftChoice})`
                      : '1. Choisissez OUI / NON / ABSTENTION puis validez'}
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
