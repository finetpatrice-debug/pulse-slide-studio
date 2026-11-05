import {
  ChevronLeft,
  ChevronRight,
  QrCode,
  Vote,
  LogOut,
  MonitorPlay,
} from 'lucide-react';

interface FloatingToolbarProps {
  currentSlide: number;
  totalSlides: number;
  participantsCount: number;
  hasActiveVote: boolean;
  pptConnected: boolean;
  pptInSlideShow: boolean;
  slideTitle: string;
  onPrevSlide: () => void;
  onNextSlide: () => void;
  onOpenQrModal: () => void;
  onLaunchResolutionVote: () => void;
  onStartPptSlideShow: () => void;
  onExitPresentation: () => void;
  onMouseEnterInteractive: () => void;
  onMouseLeaveInteractive: () => void;
}

export default function FloatingToolbar({
  currentSlide,
  totalSlides,
  participantsCount,
  hasActiveVote,
  pptConnected,
  pptInSlideShow,
  slideTitle,
  onPrevSlide,
  onNextSlide,
  onOpenQrModal,
  onLaunchResolutionVote,
  onStartPptSlideShow,
  onExitPresentation,
  onMouseEnterInteractive,
  onMouseLeaveInteractive,
}: FloatingToolbarProps) {
  return (
    <div
      onMouseEnter={onMouseEnterInteractive}
      onMouseLeave={onMouseLeaveInteractive}
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[98vw]"
    >
      <div className="flex items-center gap-2 sm:gap-3 px-4 py-2.5 rounded-2xl bg-slate-950/95 backdrop-blur-2xl border border-white/20 shadow-2xl shadow-black/90">
        {/* Bouton Lancer F5 si PowerPoint est ouvert mais pas encore en mode Diaporama */}
        {pptConnected && !pptInSlideShow && (
          <button
            type="button"
            onClick={onStartPptSlideShow}
            title="Lancer le mode Diaporama (F5) dans PowerPoint"
            className="px-3 py-2 rounded-xl bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/40 text-orange-300 text-xs font-bold flex items-center gap-1.5 shrink-0 transition"
          >
            <MonitorPlay className="w-4 h-4" />
            <span>Plein Écran F5</span>
          </button>
        )}

        {/* 1. Navigation Slides PowerPoint */}
        <div className="flex items-center gap-1.5 pr-3 border-r border-white/15 shrink-0">
          <button
            type="button"
            onClick={onPrevSlide}
            title="Slide PowerPoint précédente"
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white transition"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <div className="px-2 text-xs sm:text-sm font-extrabold text-white whitespace-nowrap flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                pptConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
              }`}
            />
            <span>
              Slide <span className="text-emerald-400">{currentSlide}</span>
              <span className="text-slate-400"> / {totalSlides}</span>
            </span>
          </div>

          <button
            type="button"
            onClick={onNextSlide}
            title="Slide PowerPoint suivante"
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white transition"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* 2. Bouton QR Code (Connexion des participants) */}
        <button
          type="button"
          onClick={onOpenQrModal}
          className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 text-xs sm:text-sm font-bold text-white flex items-center gap-2 transition shrink-0"
          title="Afficher le QR Code pour que les participants rejoignent le vote"
        >
          <QrCode className="w-4 h-4 text-indigo-400" />
          <span>QR Code</span>
          <span className="px-2 py-0.5 rounded-full text-xs font-extrabold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
            {participantsCount} présent{participantsCount > 1 ? 's' : ''}
          </span>
        </button>

        {/* 3. BOUTON PRINCIPAL : LANCER LE VOTE OUI / NON / ABSTENTION SUR CE SLIDE */}
        <button
          type="button"
          onClick={onLaunchResolutionVote}
          title={
            slideTitle
              ? `Faire voter ce slide : "${slideTitle}"`
              : `Lancer un vote OUI / NON / ABSTENTION sur le Slide ${currentSlide}`
          }
          className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white text-xs sm:text-sm font-black tracking-wide shadow-lg shadow-emerald-500/30 flex items-center gap-2 transition active:scale-95 shrink-0"
        >
          <Vote className="w-4 h-4" />
          <span>
            {hasActiveVote
              ? 'NOUVEAU VOTE (OUI / NON / ABSTENTION)'
              : `VOTER CE SLIDE (OUI / NON / ABSTENTION)`}
          </span>
        </button>

        {/* 4. Quitter la barre pour revenir à l'accueil / Exporter PV */}
        <button
          type="button"
          onClick={onExitPresentation}
          title="Revenir au tableau de bord et exporter les résultats"
          className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-rose-500/25 border border-white/10 text-xs font-bold text-slate-300 hover:text-rose-200 flex items-center gap-1.5 transition shrink-0"
        >
          <LogOut className="w-4 h-4" />
          <span className="hidden sm:inline">Tableau de bord</span>
        </button>
      </div>
    </div>
  );
}
