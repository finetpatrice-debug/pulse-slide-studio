import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { X, Users, Wifi, Copy, Check, ExternalLink, Sparkles } from 'lucide-react';
import { getNetworkBaseUrl } from '../../lib/supabase';
import type { Session, Participant } from '../../types/poll';

interface QrCodeModalOverlayProps {
  session: Session;
  participants: Participant[];
  onClose: () => void;
}

export default function QrCodeModalOverlay({
  session,
  participants,
  onClose,
}: QrCodeModalOverlayProps) {
  const [customBaseUrl, setCustomBaseUrl] = useState(getNetworkBaseUrl());
  const [copied, setCopied] = useState(false);

  const joinUrl = `${customBaseUrl.replace(/\/$/, '')}/join/${session.code}`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-40 bg-slate-950/75 backdrop-blur-2xl flex items-center justify-center p-4 sm:p-8 animate-fadeIn">
      <div className="relative max-w-5xl w-full bg-slate-900/90 border border-white/15 rounded-3xl p-6 sm:p-10 shadow-2xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
        {/* Bouton Fermer */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-5 right-5 p-2.5 rounded-2xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white border border-white/10 transition"
          title="Fermer la modale QR Code"
        >
          <X className="w-6 h-6" />
        </button>

        {/* Colonne Gauche : QR Code Géant */}
        <div className="lg:col-span-5 flex flex-col items-center text-center">
          <div className="p-6 bg-white rounded-3xl shadow-2xl shadow-indigo-500/20 border-4 border-indigo-500/30">
            <QRCodeSVG
              value={joinUrl}
              size={260}
              level="H"
              includeMargin={false}
              className="w-56 h-56 sm:w-64 sm:h-64"
            />
          </div>

          <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
            <Wifi className="w-4 h-4 text-emerald-400" />
            <span>Scannez avec l'appareil photo de votre smartphone</span>
          </div>
        </div>

        {/* Colonne Droite : Code géant + URL + Participants en direct */}
        <div className="lg:col-span-7 space-y-6">
          <div>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 mb-2">
              <Sparkles className="w-3.5 h-3.5" />
              Rejoindre la session en direct
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-white">
              {session.title}
            </h2>
          </div>

          {/* Code à 6 caractères géant */}
          <div className="p-5 rounded-3xl bg-slate-950/90 border border-indigo-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-wider font-semibold text-slate-400">
                Code d'accès rapide
              </p>
              <p className="text-4xl sm:text-5xl font-mono font-black tracking-[0.22em] text-indigo-400 mt-1">
                {session.code}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={handleCopy}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-white flex items-center justify-center gap-2 transition"
              >
                {copied ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-400" />
                    Lien copié !
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4 text-indigo-400" />
                    Copier le lien
                  </>
                )}
              </button>

              <a
                href={`/join/${session.code}`}
                target="_blank"
                rel="noreferrer"
                className="px-4 py-2 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/30 text-xs font-bold text-indigo-300 flex items-center justify-center gap-1.5 transition"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Simuler un participant
              </a>
            </div>
          </div>

          {/* Adresse réseau personnalisable si besoin */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
              URL Réseau Local encodée dans le QR Code :
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={customBaseUrl}
                onChange={(e) => setCustomBaseUrl(e.target.value)}
                className="flex-1 px-3 py-2 rounded-xl bg-slate-950/70 border border-white/10 text-xs font-mono text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <span className="text-xs font-mono text-indigo-300 shrink-0">
                /join/{session.code}
              </span>
            </div>
          </div>

          {/* Liste temps réel des participants qui scannent */}
          <div className="p-5 rounded-3xl bg-slate-950/60 border border-white/10">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-emerald-400" />
                <span className="text-sm font-bold text-white">
                  Participants connectés en direct
                </span>
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-extrabold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                {participants.length} connecté{participants.length > 1 ? 's' : ''}
              </span>
            </div>

            {participants.length === 0 ? (
              <div className="py-6 text-center text-xs text-slate-400">
                En attente des premiers participants... Les pseudos s'afficheront ici en temps réel.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto pr-1">
                {participants.map((p) => (
                  <span
                    key={p.id}
                    className="px-3.5 py-1.5 rounded-2xl bg-gradient-to-r from-indigo-500/20 to-violet-500/20 border border-indigo-400/30 text-sm font-bold text-white flex items-center gap-2 shadow-sm"
                  >
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                    {p.nickname}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
