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
} from 'lucide-react';
import { pollService } from '../services/pollService';
import type { Session, Question, Participant } from '../types/poll';

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

        const sessionQuestions = await pollService.getQuestionsBySession(foundSession.id);
        if (!cancelled) setQuestions(sessionQuestions);

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
    });

    return () => unsubscribe();
  }, [session?.id]);

  const activeQuestion = useMemo(() => {
    if (!session?.active_question_id) return null;
    return questions.find((q) => q.id === session.active_question_id) ?? null;
  }, [session?.active_question_id, questions]);

  const activeSlideNumber = activeQuestion?.slide_number || session?.current_slide || 1;

  // Réinitialiser l'état d'erreur d'image quand on change de slide
  useEffect(() => {
    setSlideImgFailed(false);
  }, [activeSlideNumber, activeQuestion?.id, activeQuestion?.correct_option]);

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
        const qList = await pollService.getQuestionsBySession(currentSession.id);
        setQuestions(qList);
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
  const slideImageUrl = activeQuestion?.correct_option?.startsWith('data:image/')
    ? activeQuestion.correct_option
    : `${baseUrl}slides/slide-${activeSlideNumber}.png`;

  // ÉCRAN 2 : CONNECTÉ — ATTENTE OU VOTE OUI / NON / ABSTENTION
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white flex flex-col">
      {/* Modale plein écran pour zoomer sur la diapositive PowerPoint */}
      {isSlideZoomed && !slideImgFailed && (
        <div
          className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center p-3"
          onClick={() => setIsSlideZoomed(false)}
        >
          <div className="w-full max-w-3xl flex items-center justify-between mb-3 px-1">
            <span className="text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-lg bg-indigo-500/30 text-indigo-200 border border-indigo-400/30">
              Diapositive {activeSlideNumber} — Aperçu complet
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
            alt={`Diapositive ${activeSlideNumber}`}
            className="w-full max-w-3xl rounded-2xl border border-white/20 shadow-2xl bg-white object-contain"
          />
          <p className="text-xs text-slate-400 mt-3">
            Touchez l'écran pour revenir aux boutons de vote
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

        <div className="flex items-center gap-2 shrink-0">
          <div className="px-2.5 py-1 rounded-xl bg-slate-800 border border-white/10 text-xs font-semibold text-slate-300 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-emerald-400" />
            <span>Slide {activeSlideNumber}</span>
          </div>
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
          <div className="bg-slate-900/80 border border-white/10 rounded-3xl p-6 text-center shadow-2xl my-auto space-y-4">
            {voteConfirmed && selectedAnswer && (
              <div className="p-3.5 rounded-2xl bg-emerald-500/20 border border-emerald-400/50 flex items-center justify-center gap-2.5 shadow-md">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <span className="text-sm font-extrabold text-emerald-100">
                  Vote définitif validé : {selectedAnswer}
                </span>
              </div>
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
          </div>
        ) : (
          /* ÉCRAN DE VOTE : SLIDE EN HAUT + OUI / NON / ABSTENTION + BOUTON VALIDER EN BAS */
          <div className="space-y-4">
            {/* 1. EN HAUT : VISUEL DE LA DIAPOSITIVE POWERPOINT SUR LAQUELLE ON VOTE */}
            <div className="bg-slate-900 border border-white/15 rounded-3xl p-3.5 shadow-xl space-y-2.5">
              <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  Slide {activeSlideNumber}
                </span>

                <div className="flex items-center gap-2">
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
