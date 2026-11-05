import React, { useEffect, useRef, useState } from 'react';

export type AnnotationTool = 'cursor' | 'pen-red' | 'pen-yellow' | 'laser';

interface AnnotationCanvasProps {
  tool: AnnotationTool;
  currentSlide: number;
  clearTrigger: number;
}

interface LaserPoint {
  x: number;
  y: number;
  timestamp: number;
}

export default function AnnotationCanvas({
  tool,
  currentSlide,
  clearTrigger,
}: AnnotationCanvasProps) {
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const laserCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const laserTrailRef = useRef<LaserPoint[]>([]);

  // Ajuster la résolution interne des canvas à la taille du conteneur
  useEffect(() => {
    const resizeCanvases = () => {
      for (const ref of [drawCanvasRef, laserCanvasRef]) {
        const canvas = ref.current;
        if (!canvas || !canvas.parentElement) continue;
        const rect = canvas.parentElement.getBoundingClientRect();
        if (canvas.width !== Math.floor(rect.width) || canvas.height !== Math.floor(rect.height)) {
          canvas.width = Math.floor(rect.width);
          canvas.height = Math.floor(rect.height);
        }
      }
    };

    resizeCanvases();
    window.addEventListener('resize', resizeCanvases);
    return () => window.removeEventListener('resize', resizeCanvases);
  }, []);

  // Effacer les annotations lors du changement de diapositive ou clic sur Gomme
  useEffect(() => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    laserTrailRef.current = [];
  }, [currentSlide, clearTrigger]);

  // Boucle d'animation pour le pointeur laser lumineux
  useEffect(() => {
    if (tool !== 'laser') {
      const lCanvas = laserCanvasRef.current;
      if (lCanvas) {
        const ctx = lCanvas.getContext('2d');
        ctx?.clearRect(0, 0, lCanvas.width, lCanvas.height);
      }
      return;
    }

    let animationFrameId: number;

    const renderLaser = () => {
      const canvas = laserCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const now = performance.now();
          laserTrailRef.current = laserTrailRef.current.filter(
            (pt) => now - pt.timestamp < 320
          );

          const pts = laserTrailRef.current;
          if (pts.length > 1) {
            for (let i = 1; i < pts.length; i++) {
              const age = now - pts[i].timestamp;
              const alpha = Math.max(0, 1 - age / 320);
              ctx.beginPath();
              ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
              ctx.lineTo(pts[i].x, pts[i].y);
              ctx.strokeStyle = `rgba(244, 63, 94, ${alpha})`;
              ctx.lineWidth = 6 * alpha;
              ctx.lineCap = 'round';
              ctx.stroke();
            }
          }

          if (pts.length > 0) {
            const head = pts[pts.length - 1];
            if (now - head.timestamp < 150) {
              ctx.beginPath();
              ctx.arc(head.x, head.y, 9, 0, Math.PI * 2);
              ctx.fillStyle = 'rgba(244, 63, 94, 0.45)';
              ctx.fill();

              ctx.beginPath();
              ctx.arc(head.x, head.y, 4.5, 0, Math.PI * 2);
              ctx.fillStyle = '#ffffff';
              ctx.fill();
            }
          }
        }
      }
      animationFrameId = requestAnimationFrame(renderLaser);
    };

    animationFrameId = requestAnimationFrame(renderLaser);
    return () => cancelAnimationFrame(animationFrameId);
  }, [tool]);

  const getCoordinates = (
    e: React.PointerEvent<HTMLCanvasElement>
  ): { x: number; y: number } => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === 'cursor') return;
    const coords = getCoordinates(e);
    if (tool === 'laser') {
      laserTrailRef.current.push({ ...coords, timestamp: performance.now() });
      return;
    }
    setIsDrawing(true);
    lastPointRef.current = coords;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === 'cursor') return;
    const coords = getCoordinates(e);

    if (tool === 'laser') {
      laserTrailRef.current.push({ ...coords, timestamp: performance.now() });
      return;
    }

    if (!isDrawing || !lastPointRef.current) return;
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.beginPath();
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    ctx.lineTo(coords.x, coords.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (tool === 'pen-red') {
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 4;
      ctx.globalAlpha = 0.95;
    } else if (tool === 'pen-yellow') {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 14;
      ctx.globalAlpha = 0.35;
    }

    ctx.stroke();
    lastPointRef.current = coords;
  };

  const handlePointerUp = () => {
    setIsDrawing(false);
    lastPointRef.current = null;
  };

  const isInteractive = tool !== 'cursor';

  return (
    <div
      className={`absolute inset-0 z-20 ${
        isInteractive ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
      style={{
        cursor:
          tool === 'laser'
            ? 'crosshair'
            : tool === 'pen-red' || tool === 'pen-yellow'
            ? 'crosshair'
            : 'default',
      }}
    >
      <canvas
        ref={drawCanvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        className="absolute inset-0 w-full h-full touch-none"
      />
      <canvas
        ref={laserCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />
    </div>
  );
}
