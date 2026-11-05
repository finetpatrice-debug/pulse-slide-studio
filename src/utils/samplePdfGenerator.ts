/**
 * Génère à la volée un vrai fichier PDF valide (5 diapositives 16:9) côté client
 * pour permettre au formateur de tester immédiatement le lecteur PDF `react-pdf`
 * s'il n'a pas encore importé son propre fichier PDF.
 */
export function createSamplePresentationPdfFile(): File {
  const slides = [
    {
      badge: 'DIAPOSITIVE 1 / 5',
      title: 'Bienvenue dans PulseSlide Live',
      subtitle: 'Presentation interactive & sondages en temps reel',
      footer: 'Scannez le QR Code en bas de l ecran pour rejoindre la session',
      bgR: '0.07',
      bgG: '0.09',
      bgB: '0.18',
    },
    {
      badge: 'DIAPOSITIVE 2 / 5  -  CONCEPT CLE',
      title: 'Synchronisation Temps Reel',
      subtitle: 'Propulse par Supabase PostgreSQL & WebSockets',
      footer: 'Question preparee associee a cette diapositive (Diapo 2)',
      bgR: '0.11',
      bgG: '0.10',
      bgB: '0.26',
    },
    {
      badge: 'DIAPOSITIVE 3 / 5  -  QUIZ INTERACTIF',
      title: 'Quiz Technique : Architecture Web',
      subtitle: 'Testez les connaissances de votre auditoire en 1 clic',
      footer: 'Utilisez le bouton Sondage de la Diapo dans la barre d outils',
      bgR: '0.08',
      bgG: '0.16',
      bgB: '0.24',
    },
    {
      badge: 'DIAPOSITIVE 4 / 5  -  EVALUATION',
      title: 'Evaluation de la Formation',
      subtitle: 'Recueillez le ressenti des participants sur une echelle de 1 a 5',
      footer: 'Les barres de progression s animent en direct a chaque vote',
      bgR: '0.16',
      bgG: '0.09',
      bgB: '0.24',
    },
    {
      badge: 'DIAPOSITIVE 5 / 5  -  QUESTIONS OUVERTES',
      title: 'Brainstorming & Questions / Reponses',
      subtitle: 'Lancez une question ouverte ou un Sondage Express a la volee',
      footer: 'Exportez ensuite tous les resultats en CSV depuis le tableau de bord',
      bgR: '0.07',
      bgG: '0.18',
      bgB: '0.18',
    },
  ];

  const escapePdfText = (txt: string) =>
    txt.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const objects: string[] = [];
  const addObj = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  // 1: Catalog, 2: Pages, 3: Font Helvetica-Bold, 4: Font Helvetica
  addObj('<< /Type /Catalog /Pages 2 0 R >>');
  addObj(''); // placeholder for Pages
  const fontBoldId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const fontRegularId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds: number[] = [];

  for (const s of slides) {
    const contentLines = [
      // Background rectangle (960 x 540 - 16:9 format)
      `${s.bgR} ${s.bgG} ${s.bgB} rg`,
      '0 0 960 540 re f',
      // Decorative top bar
      '0.39 0.40 0.95 rg',
      '0 528 960 12 re f',
      // Card frame
      '0.14 0.17 0.28 rg',
      '60 90 840 370 re f',
      // Badge text
      'BT',
      `/F1 14 Tf`,
      '0.55 0.62 0.98 rg',
      '100 410 Td',
      `(${escapePdfText(s.badge)}) Tj`,
      'ET',
      // Title text
      'BT',
      `/F1 36 Tf`,
      '1 1 1 rg',
      '100 330 Td',
      `(${escapePdfText(s.title)}) Tj`,
      'ET',
      // Subtitle text
      'BT',
      `/F2 22 Tf`,
      '0.82 0.86 0.95 rg',
      '100 270 Td',
      `(${escapePdfText(s.subtitle)}) Tj`,
      'ET',
      // Footer text
      'BT',
      `/F2 16 Tf`,
      '0.60 0.66 0.80 rg',
      '100 140 Td',
      `(${escapePdfText(s.footer)}) Tj`,
      'ET',
    ];

    const streamData = contentLines.join('\n');
    const contentId = addObj(
      `<< /Length ${streamData.length} >>\nstream\n${streamData}\nendstream`
    );

    const pageId = addObj(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 ${fontBoldId} 0 R /F2 ${fontRegularId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${
    pageIds.length
  } >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  const blob = new Blob([pdf], { type: 'application/pdf' });
  return new File([blob], 'Support_Demo_PulseSlide.pdf', { type: 'application/pdf' });
}
