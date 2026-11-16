# Règles de Prévention Quota & Facturation — Pulse Slide Studio (Supabase Gratuit)

Ces règles sont obligatoires et permanentes pour garantir que l'application reste 100 % dans les limites du forfait gratuit Supabase (0 €) même lors d'assemblées de 300 personnes et 50 décisions :

1. **Zéro Image / Base64 dans Supabase (Anti-Egress)** :
   - Ne JAMAIS stocker d'image (`data:image/...` ou base64) dans les tables `questions`, `sessions`, `participants` ou `votes` de Supabase.
   - Seuls les textes légers (titre de la proposition, options `OUI / NON / ABSTENTION`, réponses) sont transmis.

2. **Zéro Rafraîchissement Lourd en Boucle (Anti-Saturation Réseau)** :
   - Ne jamais exécuter de `SELECT *` en boucle rapide (< 2 secondes) depuis les téléphones ou le serveur local.
   - Les téléphones ne vérifient que l'état de la session (`id, active_question_id, show_results, current_slide` ~150 octets) et ne chargent la liste des questions que lorsque `active_question_id` ou `show_results` change réellement.

3. **Surveillance & Prévention Automatique (`scripts/health-check.cjs`)** :
   - Lors de chaque vérification quotidienne à 09h00, auditer le volume de la base (`questions`, `votes`, `participants`, absence d'images) et purger immédiatement toute image base64 accidentelle.
   - Si le nombre de votes stockés dépasse `12 000` ou si une anomalie de consommation est détectée, afficher immédiatement le **Modèle d'Alerte de Dépassement d'Activité** à l'utilisateur en lui proposant d'exporter le Procès-Verbal CSV et de vider l'historique des anciens scrutins.
