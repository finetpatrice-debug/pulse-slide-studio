import React, { createContext, useContext, useState } from 'react';

interface PresentationContextValue {
  pdfFile: File | null;
  setPdfFile: (file: File | null) => void;
  totalSlides: number;
  setTotalSlides: (count: number) => void;
}

const PresentationContext = createContext<PresentationContextValue | undefined>(undefined);

export function PresentationProvider({ children }: { children: React.ReactNode }) {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [totalSlides, setTotalSlides] = useState<number>(1);

  return (
    <PresentationContext.Provider
      value={{
        pdfFile,
        setPdfFile,
        totalSlides,
        setTotalSlides,
      }}
    >
      {children}
    </PresentationContext.Provider>
  );
}

export function usePresentation() {
  const ctx = useContext(PresentationContext);
  if (!ctx) {
    throw new Error('usePresentation doit être utilisé dans un PresentationProvider');
  }
  return ctx;
}
