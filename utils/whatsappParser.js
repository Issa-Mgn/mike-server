/**
 * Parse un fichier .txt d'export WhatsApp
 * Formats supportés:
 * - [JJ/MM/AAAA, HH:MM:SS] Nom: message
 * - [JJ/MM/AAAA HH:MM:SS] Nom: message
 * - [M/D/YY, H:MM AM/PM] Name: message (format US)
 */

function parseWhatsAppExport(content) {
  const lines = content.split('\n');
  const messages = [];
  
  console.log(`🔍 Parsing ${lines.length} lignes...`);
  console.log(`📄 Premières lignes:`, lines.slice(0, 3));
  
  // Regex pour détecter le début d'un nouveau message
  // Format réel WhatsApp: JJ/MM/AAAA, HH:MM - Nom: message
  // Ou avec crochets: [JJ/MM/AAAA, HH:MM:SS] Nom: message
  const messageRegex = /^(\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*([^:]+):\s*(.+)$/;
  const messageRegexBrackets = /^\[(\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]+):\s*(.+)$/;
  
  let currentMessage = null;
  let matchCount = 0;

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    // Ignorer les messages système de WhatsApp
    if (line.includes('chiffrés de bout en bout') || 
        line.includes('Messages and calls are end-to-end encrypted') ||
        line.includes('<Médias omis>') ||
        line.includes('Media omitted')) {
      continue;
    }

    // Essayer les deux formats
    let match = line.match(messageRegex);
    if (!match) {
      match = line.match(messageRegexBrackets);
    }
    
    if (match) {
      matchCount++;
      // Nouveau message détecté
      if (currentMessage) {
        messages.push(currentMessage);
      }
      
      const [, timestamp, author, message] = match;
      currentMessage = {
        timestamp: timestamp.trim(),
        author: author.trim(),
        message: message.trim()
      };
    } else if (currentMessage) {
      // Continuation d'un message multiligne
      currentMessage.message += ' ' + line;
    }
  }
  
  // Ajouter le dernier message
  if (currentMessage) {
    messages.push(currentMessage);
  }

  console.log(`✅ ${matchCount} messages matchés, ${messages.length} messages parsés`);

  return messages;
}

/**
 * Extrait les statistiques de base de la conversation
 */
function extractStats(messages) {
  if (messages.length === 0) {
    return {
      totalMessages: 0,
      participantCount: 0,
      participants: [],
      participantStats: {},
      dateRange: null,
      durationMonths: 0
    };
  }

  const participants = {};
  const dates = [];
  
  messages.forEach(msg => {
    if (!participants[msg.author]) {
      participants[msg.author] = {
        totalMessages: 0,
        totalWords: 0
      };
    }
    
    participants[msg.author].totalMessages++;
    participants[msg.author].totalWords += msg.message.split(/\s+/).length;
    
    // Extraire les dates pour calculer la durée
    try {
      // Format: JJ/MM/AAAA, HH:MM ou JJ/MM/AAAA, HH:MM:SS
      const dateMatch = msg.timestamp.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (dateMatch) {
        const [, day, month, year] = dateMatch;
        dates.push(new Date(year, month - 1, day));
      }
    } catch (e) {
      // Ignorer les erreurs de parsing de date
    }
  });

  // Calculer la période de la conversation
  let dateRange = null;
  let durationMonths = 0;
  
  if (dates.length > 0) {
    dates.sort((a, b) => a - b);
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];
    
    dateRange = {
      start: firstDate.toLocaleDateString('fr-FR'),
      end: lastDate.toLocaleDateString('fr-FR')
    };
    
    // Calculer la durée en mois
    const diffTime = Math.abs(lastDate - firstDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    durationMonths = Math.round(diffDays / 30);
  }

  return {
    totalMessages: messages.length,
    participantCount: Object.keys(participants).length,
    participants: Object.keys(participants),
    participantStats: participants,
    dateRange,
    durationMonths
  };
}

module.exports = {
  parseWhatsAppExport,
  extractStats
};
