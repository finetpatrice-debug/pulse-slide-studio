import { useMemo, useState } from 'react';
import {
  Minimize2,
  Maximize2,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Users,
  CheckCircle2,
  XCircle,
  MinusCircle,
  X,
  PanelRight,
} from 'lucide-react';
import type { Session, Question, Participant, Vote } from '../../types/poll';

interface ActivePollOverlayProps {
  session: Session;
  question: Question;
  participants: Participant[];
  votes: Vote[];
  minimized: boolean;
  onToggleMinimize: () => void;
  onToggleOpenVote: () => void;
  onToggleShowResults: () => void;
  onToggleRevealAnswer: () => void;
  onClosePoll: () => void;
}

export default function ActivePollOverlay({
  session,
  question,
  participants,
  votes,
  minimized,
  onToggleMinimize,
  onToggleOpenVote,
  onToggleShowResults,
  onClosePoll,
}: ActivePollOverlayProps) {
  // Par défaut, s'affiche en encadré latéral à droite pour laisser le texte du slide PowerPoint lisible
  const [fullCenter, setFullCenter] = useState(false);

  const questionVotes = useMemo(
    () => votes.filter((v) => v.question_id === question.id),
    [votes, question.id]
  );

  const totalVotes = questionVotes.length;
  const totalParticipants = participants.length;

  // Comptabilisation OUI / NON / ABSTENTION
  const stats = useMemo(() => {
    const opts =
      question.options.length > 0 ? question.options : ['OUI', 'NON', 'ABSTENTION'];

    let ouiCount = 0;
    let nonCount = 0;
    let abstentionCount = 0;

    const items = opts.map((opt) => {
      const upper = opt.trim().toUpperCase();
      const count = questionVotes.filter(
        (v) => v.answer.trim().toUpperCase() === upper
      ).length;
      const percent = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;

      if (upper === 'OUI' || upper === 'POUR') ouiCount += count;
      else if (upper === 'NON' || upper === 'CONTRE') nonCount += count;
      else abstentionCount += count;

      return {
        label: opt,
        upper,
        count,
        percent,
      };
    });

    const expressed = ouiCount + nonCount;
    let decision: 'ADOPTED' | 'REJECTED' | 'NONE' = 'NONE';
    if (expressed > 0) {
      decision = ouiCount > nonCount ? 'ADOPTED' : 'REJECTED';
    }

    return {
      items,
      ouiCount,
      nonCount,
      abstentionCount,
      expressed,
      decision,
    };
  }, [question.options, questionVotes, totalVotes]);

  // --------------------------------------------------------------------------
  // MODE RÉDUIT : Petit bandeau en haut de la slide PowerPoint
  // --------------------------------------------------------------------------
  if (minimized) {
    return (
      <div className="fixed top-4 right-4 z-40 flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-slate-950/90 backdrop-blur-xl border border-emerald-500/40 shadow-2xl">
        <span
          className={`w-2.5 h-2.5 rounded-full ${
            question.is_open ? 'bg-emerald-400 animate-ping' : 'bg-amber-400'
          }`}
        />
        <span className="text-xs font-extrabold text-white">
          Vote en cours : {totalVotes} / {totalParticipants} votants
        </span>
        <button
          type="button"
          onClick={onToggleMinimize}
          className="px-3 py-1 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white flex items-center gap-1.5 transition"
        >
          <Maximize2 className="w-3.5 h-3.5" />
          Voir les résultats
        </button>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // MODE PANNEAU DE VOTE (Latéral à droite de PowerPoint OU Centré en grand)
  // --------------------------------------------------------------------------
  return (
    <div className="fixed inset-0 z-40 bg-slate-950 flex flex-col justify-between p-5 overflow-y-auto">
      <div className="w-full max-w-2xl mx-auto flex-1 flex flex-col justify-between">
        {/* Barre supérieure du panneau */}
        <div className="flex items-center justify-between gap-2 pb-3.5 border-b border-white/10">
          <div className="flex items-center gap-2">
            <span
              className={`px-2.5 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 border ${
                question.is_open
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  question.is_open ? 'bg-emerald-400 animate-ping' : 'bg-amber-400'
                }`}
              />
              {question.is_open ? 'Scrutin ouvert' : 'Scrutin clôturé'}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setFullCenter((prev) => !prev)}
              title={
                fullCenter
                  ? 'Placer sur le côté droit pour lire le texte du slide'
                  : 'Agrandir au centre de l’écran'
              }
              className="px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 flex items-center gap-1.5 border border-white/10 transition"
            >
              <PanelRight className="w-3.5 h-3.5 text-indigo-400" />
              <span>{fullCenter ? 'Côté droit' : 'Agrandir'}</span>
            </button>

            <button
              type="button"
              onClick={onToggleMinimize}
              title="Masquer temporairement la fenêtre de vote"
              className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-white/10 transition"
            >
              <Minimize2 className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={onClosePoll}
              title="Fermer ce vote"
              className="p-1.5 rounded-xl bg-slate-800 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 border border-white/10 transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Titre du texte voté & Compteur de participation */}
        <div className="py-4 space-y-3">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-400">
              Slide PowerPoint {question.slide_number || session.current_slide}
            </span>
            <h2 className="text-base sm:text-lg font-extrabold text-white leading-snug mt-0.5">
              {question.title}
            </h2>
          </div>

          <div className="px-3.5 py-2.5 rounded-2xl bg-slate-900 border border-white/10 flex items-center justify-between">
            <span className="text-xs text-slate-300 flex items-center gap-2 font-medium">
              <Users className="w-4 h-4 text-emerald-400" />
              Participation en direct
            </span>
            <span className="text-sm font-black text-white">
              {totalVotes} vote{totalVotes > 1 ? 's' : ''}{' '}
              <span className="text-xs font-normal text-slate-400">
                / {totalParticipants} présent{totalParticipants > 1 ? 's' : ''}
              </span>
            </span>
          </div>
        </div>

        {/* Décision officielle lorsque le vote est clôturé */}
        {!question.is_open && (
          <div
            className={`mb-4 p-4 rounded-2xl border-2 flex items-center justify-between ${
              stats.decision === 'ADOPTED'
                ? 'bg-emerald-500/20 border-emerald-400 text-emerald-100'
                : stats.decision === 'REJECTED'
                ? 'bg-rose-500/20 border-rose-400 text-rose-100'
                : 'bg-slate-800/80 border-slate-600 text-slate-200'
            }`}
          >
            <div className="flex items-center gap-3">
              {stats.decision === 'ADOPTED' ? (
                <CheckCircle2 className="w-7 h-7 text-emerald-400 shrink-0" />
              ) : stats.decision === 'REJECTED' ? (
                <XCircle className="w-7 h-7 text-rose-400 shrink-0" />
              ) : (
                <MinusCircle className="w-7 h-7 text-slate-400 shrink-0" />
              )}
              <div>
                <p className="text-base font-black uppercase tracking-wide">
                  {stats.decision === 'ADOPTED' && 'TEXTE ADOPTÉ'}
                  {stats.decision === 'REJECTED' && 'TEXTE REJETÉ'}
                  {stats.decision === 'NONE' && 'AUCUN SUFFRAGE EXPRIMÉ'}
                </p>
                <p className="text-xs opacity-90">
                  OUI : {stats.ouiCount} • NON : {stats.nonCount} • ABSTENTION :{' '}
                  {stats.abstentionCount}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Barres de résultats OUI / NON / ABSTENTION */}
        {!session.show_results ? (
          <div className="py-8 px-4 rounded-2xl bg-slate-900/70 border border-white/10 text-center space-y-2">
            <EyeOff className="w-7 h-7 text-slate-400 mx-auto" />
            <p className="text-xs font-bold text-white">
              Résultats masqués pendant le vote ({totalVotes} vote{totalVotes > 1 ? 's' : ''} reçu{totalVotes > 1 ? 's' : ''})
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {stats.items.map((item) => {
              let barColor = 'from-slate-400 to-slate-500';
              let badgeColor = 'text-slate-300';
              let IconComp = MinusCircle;

              if (item.upper === 'OUI' || item.upper === 'POUR') {
                barColor = 'from-emerald-500 to-teal-400';
                badgeColor = 'text-emerald-400';
                IconComp = CheckCircle2;
              } else if (item.upper === 'NON' || item.upper === 'CONTRE') {
                barColor = 'from-rose-500 to-red-500';
                badgeColor = 'text-rose-400';
                IconComp = XCircle;
              }

              return (
                <div
                  key={item.label}
                  className="p-3.5 rounded-2xl bg-slate-900/90 border border-white/10"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <IconComp className={`w-5 h-5 ${badgeColor}`} />
                      <span className="font-extrabold text-sm sm:text-base text-white uppercase">
                        {item.label}
                      </span>
                    </div>

                    <div className="text-right">
                      <span className="text-base sm:text-lg font-black text-white">
                        {item.count} voix
                      </span>
                      <span className="text-xs font-bold text-slate-400 ml-2">
                        ({item.percent}%)
                      </span>
                    </div>
                  </div>

                  <div className="w-full h-3.5 bg-slate-800 rounded-full overflow-hidden">
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

        {/* Boutons d'action en bas du panneau */}
        <div className="pt-4 mt-4 border-t border-white/10 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={onToggleOpenVote}
            className={`flex-1 py-3 px-4 rounded-xl text-xs sm:text-sm font-extrabold flex items-center justify-center gap-2 transition ${
              question.is_open
                ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-lg'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
            }`}
          >
            {question.is_open ? (
              <>
                <Lock className="w-4 h-4" />
                Clôturer le vote & proclamer
              </>
            ) : (
              <>
                <Unlock className="w-4 h-4" />
                Rouvrir le vote
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onToggleShowResults}
            title={session.show_results ? 'Masquer les barres' : 'Afficher les barres'}
            className="p-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 text-slate-200 transition"
          >
            {session.show_results ? (
              <EyeOff className="w-4 h-4" />
            ) : (
              <Eye className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
