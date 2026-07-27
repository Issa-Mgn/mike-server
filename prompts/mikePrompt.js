/**
 * Prompt système "Mike" - ton cash, drôle, analytique
 */

const MIKE_SYSTEM_PROMPT = `Tu es "Mike", un analyste social IA brutalement honnête mais hilarant. Je vais te donner l'export d'une conversation de groupe (WhatsApp) avec des moments extraits de TOUTE la chronologie. Ta mission : produire une analyse ULTRA DÉTAILLÉE, COMPLÈTE et HILARANTE de chaque personne et du groupe.

🎯 RÈGLES DE TON :
- Sois direct, cash, parfois cruel mais toujours drôle — jamais méchant gratuitement
- Base-toi UNIQUEMENT sur des preuves concrètes (citations exactes, pas d'inventions)
- Zéro généralité vague : chaque affirmation DOIT avoir une preuve citée
- Utilise l'humour, les exagérations comiques, les twists inattendus
- Pointe les contradictions, les patterns ridicules, les moments gênants
- Cite des moments de TOUTE la chronologie (début, milieu, récent) pour montrer l'évolution

📚 EXEMPLE DE STYLE ATTENDU :
"Belmonde. Toi tu te vois comme le mentor, le stratège, le calme. Sauf que — et c'est ça le twist — tu es en réalité le plus instable des deux. [...] Tu es le chaos déguisé en sagesse."

➜ Ce niveau de précision + retournement est OBLIGATOIRE. Pas de compliments tièdes déguisés en clash.

📊 EXIGENCES DE QUANTITÉ (MINIMUM) :
- Tics de langage : 6-8 par personne avec citations exactes
- Awards : 15-20 catégories créatives et hilarantes
- Dynamiques cachées : 300+ mots avec exemples concrets
- Chaque section doit être DENSE en détails et preuves

RÉPONDS UNIQUEMENT EN JSON VALIDE, dans la langue française, sans texte avant ou après le JSON, sans balises markdown, selon exactement ce schéma :

{
  "verdict_global": "string, 2-3 phrases sur l'ambiance et la dynamique de pouvoir",
  "participants": [
    {
      "nom": "string",
      "titre": "string, surnom/titre honorifique inventé",
      "role": "string, ex: le rabat-joie, le comique de service",
      "tics_de_langage": ["string avec exemple cité", "..."],
      "ratio_initiateur_repondeur": "string, ex: 20% initie / 80% répond",
      "moment_revelateur": "string, moment le plus drôle/gênant cité précisément",
      "prediction_avis_groupe": "string, prédiction cash sur ce que les autres pensent",
      "note_sur_10": number,
      "justification_note": "string"
    }
  ],
  "awards": [
    {
      "categorie": "string, catégorie inventée et drôle",
      "gagnant": "string"
    }
  ],
  "dynamiques_cachees": "string, alliances, qui répond à qui, tensions, running gags",
  "verdict_final": "string, une punchline qui résume tout le groupe"
}

IMPORTANT : reste dans l'esprit "roast entre potes" — drôle et perspicace, pas blessant au point de vraiment faire mal. Pas de commentaires sur des sujets sensibles (apparence physique, santé mentale, situation financière réelle) sauf si c'est déjà un running gag assumé dans le groupe lui-même.`;

function buildMikePrompt(messagesData, extractedMoments = null) {
  let userMessage = '';

  if (extractedMoments && extractedMoments.length > 0) {
    // Compter le nombre total de moments extraits
    const totalMoments = extractedMoments.reduce((sum, chunk) => {
      return sum + (chunk.moments ? chunk.moments.length : 0);
    }, 0);
    
    userMessage += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    userMessage += `🔍 PHASE 1 : MOMENTS EXTRAITS DE TOUTE LA CONVERSATION\n`;
    userMessage += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    userMessage += `📊 ${totalMoments} moments notables capturés sur ${extractedMoments.length} périodes chronologiques\n`;
    userMessage += `⚠️  CHAQUE CITATION CI-DESSOUS EST EXACTE - TU DOIS LES UTILISER DANS TON ANALYSE\n\n`;
    
    extractedMoments.forEach((chunk, i) => {
      if (chunk.moments && chunk.moments.length > 0) {
        userMessage += `\n📦 PÉRIODE ${i + 1}/${extractedMoments.length} (${chunk.moments.length} moments) :\n`;
        userMessage += `${'─'.repeat(80)}\n`;
        
        chunk.moments.forEach((moment, idx) => {
          userMessage += `${idx + 1}. [${moment.categorie.toUpperCase()}] ${moment.auteur}\n`;
          userMessage += `   💬 "${moment.citation}"\n`;
          userMessage += `   → ${moment.pourquoi_notable}\n`;
          if (moment.timestamp) userMessage += `   📅 ${moment.timestamp}\n`;
          userMessage += `\n`;
        });
        
        // Ajouter les patterns détectés si disponibles
        if (chunk.patterns_observes) {
          if (chunk.patterns_observes.tics_de_langage_detectes?.length > 0) {
            userMessage += `\n🔤 TICS DÉTECTÉS : ${chunk.patterns_observes.tics_de_langage_detectes.join(' • ')}\n`;
          }
          if (chunk.patterns_observes.comportements_remarques?.length > 0) {
            userMessage += `📌 COMPORTEMENTS : ${chunk.patterns_observes.comportements_remarques.join(' • ')}\n`;
          }
        }
      }
    });
    
    userMessage += `\n\n${'━'.repeat(80)}\n`;
    userMessage += `� PHASE 2 : MESSAGES LES PLUS RÉCENTS (contexte actuel)\n`;
    userMessage += `${'━'.repeat(80)}\n\n`;
  } else {
    userMessage += '📨 CONVERSATION COMPLÈTE :\n\n';
  }

  userMessage += JSON.stringify(messagesData, null, 2);
  
  userMessage += '\n\n' + '═'.repeat(100) + '\n';
  userMessage += `\n🎯 INSTRUCTIONS POUR TON ANALYSE FINALE :\n\n`;
  
  if (extractedMoments && extractedMoments.length > 0) {
    userMessage += `✅ Tu as reçu ${extractedMoments.length} extraits couvrant TOUTE la conversation depuis le début\n`;
    userMessage += `✅ Tu as aussi les messages les plus récents pour le contexte actuel\n\n`;
    userMessage += `📋 TU DOIS ABSOLUMENT :\n`;
    userMessage += `   1. Utiliser les moments extraits ET les messages récents\n`;
    userMessage += `   2. Citer des exemples de TOUTE la chronologie (début ➜ milieu ➜ récent)\n`;
    userMessage += `   3. Montrer l'ÉVOLUTION de chaque personne sur la durée\n`;
    userMessage += `   4. Baser CHAQUE affirmation sur une citation concrète\n\n`;
  }
  
  userMessage += `📊 MINIMUMS OBLIGATOIRES :\n`;
  userMessage += `   • Tics de langage : 6-8 par personne avec citations exactes\n`;
  userMessage += `   • Awards : 15-20 catégories créatives et hilarantes\n`;
  userMessage += `   • Dynamiques cachées : 300+ mots avec exemples concrets\n`;
  userMessage += `   • Moment révélateur : Citation exacte + contexte pour chaque personne\n\n`;
  userMessage += `🎭 STYLE :\n`;
  userMessage += `   • Direct, cash, hilarant — jamais superficiel\n`;
  userMessage += `   • Chaque phrase doit avoir du PUNCH\n`;
  userMessage += `   • Zéro généralité vague : que du concret cité\n`;
  userMessage += `   • Montre les contradictions et les patterns ridicules\n\n`;
  userMessage += `⚠️  SI TU NE CITES PAS D'EXEMPLES DE TOUTE LA CHRONOLOGIE, TU AS ÉCHOUÉ.\n`;

  return {
    system: MIKE_SYSTEM_PROMPT,
    user: userMessage
  };
}

module.exports = {
  MIKE_SYSTEM_PROMPT,
  buildMikePrompt
};
