const { get_encoding } = require('tiktoken');

// Approximation du nombre de tokens pour un texte donné
// Utilise l'encodeur cl100k_base (compatible GPT-4, approximation pour autres modèles)
function countTokens(text) {
  try {
    const encoding = get_encoding('cl100k_base');
    const tokens = encoding.encode(text);
    const count = tokens.length;
    encoding.free();
    return count;
  } catch (error) {
    // Fallback: approximation grossière (1 token ≈ 4 caractères)
    return Math.ceil(text.length / 4);
  }
}

/**
 * Découpe les messages en chunks si nécessaire
 * @param {Array} messages - Liste des messages parsés
 * @param {Number} maxTokens - Limite de tokens par chunk
 * @returns {Array} - Chunks avec résumés si nécessaire
 */
function chunkMessages(messages, maxTokens = 30000) {
  const fullText = JSON.stringify(messages);
  const totalTokens = countTokens(fullText);

  console.log(`📊 Total tokens estimés: ${totalTokens}`);

  // Si le texte tient dans la limite, pas de chunking
  if (totalTokens <= maxTokens) {
    return {
      needsChunking: false,
      fullMessages: messages,
      totalTokens
    };
  }

  // Sinon, découper en chunks chronologiques (plus gros chunks = moins d'appels)
  const targetChunks = Math.ceil(totalTokens / maxTokens);
  const chunkSize = Math.ceil(messages.length / targetChunks);
  const chunks = [];

  console.log(`📦 Découpage en ${targetChunks} chunks de ~${chunkSize} messages`);

  for (let i = 0; i < messages.length; i += chunkSize) {
    chunks.push(messages.slice(i, i + chunkSize));
  }

  return {
    needsChunking: true,
    chunks,
    totalTokens,
    mostRecentChunk: chunks[chunks.length - 1]
  };
}

module.exports = {
  countTokens,
  chunkMessages
};
