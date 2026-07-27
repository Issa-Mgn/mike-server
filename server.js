require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const os = require('os');

const { parseWhatsAppExport, extractStats } = require('./utils/whatsappParser');
const { chunkMessages } = require('./utils/tokenCounter');
const LLMClient = require('./services/llmClient');
const { buildMikePrompt } = require('./prompts/mikePrompt');

const app = express();
const PORT = process.env.PORT || 3001;

// Configuration pour gérer de multiples requêtes concurrentes
app.use(cors({
  origin: true,
  credentials: true,
  maxAge: 86400
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Augmenter les limites de connexions simultanées
require('http').globalAgent.maxSockets = 100;
require('https').globalAgent.maxSockets = 100;

// Configuration upload avec mémoire tampon pour éviter les crashes
const upload = multer({
  dest: 'uploads/',
  limits: { 
    fileSize: 50 * 1024 * 1024, // 50 MB max
    files: 1 // Un seul fichier à la fois
  },
  fileFilter: (req, file, cb) => {
    console.log('🔍 Vérification fichier:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    });
    
    if (file.mimetype === 'application/zip' || 
        file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Seuls les fichiers .zip sont acceptés'));
    }
  }
});

// Queue pour gérer les requêtes (max 50 simultanées)
const analysisQueue = [];
let activeAnalysis = 0;
const MAX_CONCURRENT_ANALYSIS = 50;

// Stockage temporaire des résultats d'analyse (en mémoire)
// Format: { analysisId: { status: 'pending'|'completed'|'error', result: data, timestamp: Date } }
const analysisResults = new Map();

// Nettoyer les anciens résultats toutes les heures
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, data] of analysisResults.entries()) {
    if (data.timestamp < oneHourAgo) {
      analysisResults.delete(id);
      console.log(`🧹 Nettoyage résultat expiré: ${id}`);
    }
  }
}, 60 * 60 * 1000);

async function processAnalysisQueue() {
  while (analysisQueue.length > 0 && activeAnalysis < MAX_CONCURRENT_ANALYSIS) {
    const task = analysisQueue.shift();
    activeAnalysis++;
    
    task.process()
      .finally(() => {
        activeAnalysis--;
        processAnalysisQueue();
      });
  }
}

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    provider: process.env.LLM_PROVIDER || 'mistral'
  });
});

/**
 * Endpoint pour parser le fichier et obtenir les stats SANS analyser
 */
app.post('/api/parse', upload.single('conversation'), async (req, res) => {
  let tempFilePath = null;

  try {
    console.log('📥 Parse request received');
    
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier uploadé' });
    }

    tempFilePath = req.file.path;

    // 1. Dézipper et extraire le .txt
    const zip = new AdmZip(tempFilePath);
    const zipEntries = zip.getEntries();
    
    const txtEntry = zipEntries.find(entry => 
      entry.entryName.endsWith('.txt') && !entry.isDirectory
    );

    if (!txtEntry) {
      return res.status(400).json({ 
        error: 'Aucun fichier .txt trouvé dans le .zip.' 
      });
    }

    const txtContent = txtEntry.getData().toString('utf8');

    // 2. Parser le contenu WhatsApp
    const messages = parseWhatsAppExport(txtContent);

    if (messages.length === 0) {
      return res.status(400).json({ 
        error: 'Aucun message valide détecté.' 
      });
    }

    // 3. Extraire les stats
    const stats = extractStats(messages);
    console.log(`📊 Stats extraites : ${stats.totalMessages} messages, ${stats.participantCount} participants`);

    // 4. Retourner uniquement les stats
    res.json({
      success: true,
      stats: {
        totalMessages: stats.totalMessages,
        participantCount: stats.participantCount,
        participants: stats.participants,
        dateRange: stats.dateRange,
        durationMonths: stats.durationMonths
      }
    });

  } catch (error) {
    console.error('❌ Erreur parse:', error.message);
    res.status(500).json({
      error: 'Erreur lors du parsing',
      message: error.message
    });

  } finally {
    // Nettoyage du fichier temporaire
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupError) {
        console.warn('⚠️ Erreur nettoyage fichier:', cleanupError.message);
      }
    }
  }
});

/**
 * Endpoint principal : analyse d'une conversation WhatsApp
 * Utilise une queue pour gérer jusqu'à 50 requêtes simultanées
 */
app.post('/api/analyze', upload.single('conversation'), async (req, res) => {
  // Ajouter à la queue et traiter
  return new Promise((resolve) => {
    const task = {
      process: async () => {
        let tempFilePath = null;

        try {
          console.log('📥 Requête reçue (Active:', activeAnalysis, '/ Queue:', analysisQueue.length, ')');
          console.log('   Fichier:', req.file ? req.file.originalname : 'aucun');
          
          if (!req.file) {
            console.log('❌ Aucun fichier uploadé');
            res.status(400).json({ error: 'Aucun fichier uploadé' });
            return resolve();
          }

          tempFilePath = req.file.path;

          // 1. Dézipper et extraire le .txt
          const zip = new AdmZip(tempFilePath);
          const zipEntries = zip.getEntries();
          
          const txtEntry = zipEntries.find(entry => 
            entry.entryName.endsWith('.txt') && !entry.isDirectory
          );

          if (!txtEntry) {
            res.status(400).json({ 
              error: 'Aucun fichier .txt trouvé dans le .zip. Assurez-vous d\'avoir exporté correctement votre conversation WhatsApp.' 
            });
            return resolve();
          }

          const txtContent = txtEntry.getData().toString('utf8');

          // 2. Parser le contenu WhatsApp
          const messages = parseWhatsAppExport(txtContent);

          if (messages.length === 0) {
            res.status(400).json({ 
              error: 'Aucun message valide détecté. Vérifiez que le fichier est bien un export WhatsApp.' 
            });
            return resolve();
          }

          const stats = extractStats(messages);
          console.log(`📊 Conversation parsée : ${stats.totalMessages} messages, ${stats.participantCount} participants`);

          // 3. Gérer le chunking si nécessaire pour analyser TOUS les messages
          const chunking = chunkMessages(messages, 30000);
          let summaries = null;

          const llmClient = new LLMClient();

          if (chunking.needsChunking) {
            console.log(`🔪 Chunking nécessaire : ${chunking.chunks.length} chunks`);
            console.log(`📝 Phase 1 : Extraction des moments notables de ${chunking.chunks.length - 1} chunks...`);
            summaries = [];
            
            // Extraire les moments notables de tous les chunks sauf le dernier
            const chunksToAnalyze = chunking.chunks.slice(0, -1);
            
            for (let i = 0; i < chunksToAnalyze.length; i++) {
              console.log(`   📦 Chunk ${i + 1}/${chunksToAnalyze.length}...`);
              try {
                const momentsJson = await llmClient.extractMoments(
                  chunksToAnalyze[i], 
                  i, 
                  chunking.chunks.length
                );
                
                // Parser le JSON des moments
                const moments = JSON.parse(momentsJson.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
                summaries.push(moments);
                
                // Afficher le nombre de moments trouvés
                const momentCount = moments.moments ? moments.moments.length : 0;
                console.log(`      ✅ ${momentCount} moments capturés`);
                
                // Petit délai entre requêtes
                await new Promise(resolve => setTimeout(resolve, 100));
              } catch (error) {
                console.warn(`      ⚠️ Erreur sur chunk ${i + 1}: ${error.message}`);
                summaries.push({ moments: [] });
              }
            }
            
            // Compter le total de moments extraits
            const totalMoments = summaries.reduce((sum, s) => sum + (s.moments?.length || 0), 0);
            console.log(`✅ Phase 1 terminée : ${totalMoments} moments extraits de ${summaries.length} chunks`);
            console.log(`📨 Phase 2 : Analyse finale avec ${chunking.mostRecentChunk.length} messages récents...`);
          }

          // 4. Construire le prompt Mike avec TOUS les messages (via résumés + dernier chunk)
          const messagesForAnalysis = chunking.needsChunking 
            ? chunking.mostRecentChunk 
            : messages;

          const mikePrompt = buildMikePrompt(messagesForAnalysis, summaries);

          // 5. Appel au LLM (premier essai) avec fallback auto
          console.log(`🤖 Appel au LLM pour l'analyse finale...`);
          console.log(`📊 Utilisation de ${summaries ? summaries.length : 0} extraits de moments`);
          let response = await llmClient.chat(
            mikePrompt.system,
            mikePrompt.user,
            { 
              jsonMode: true, 
              temperature: 0.85,  // Plus créatif
              maxTokens: 8000     // Encore plus de tokens pour des réponses ultra détaillées
            }
          );

          // 6. Parser le JSON
          let analysis;
          try {
            // Nettoyer la réponse (enlever markdown potentiel)
            response = response.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            analysis = JSON.parse(response);
          } catch (parseError) {
            console.warn('⚠️ JSON invalide, retry avec instruction renforcée...');
            
            // Retry avec instruction explicite
            const retryPrompt = mikePrompt.user + '\n\nATTENTION : réponds UNIQUEMENT en JSON valide, sans texte avant/après, sans balises markdown.';
            response = await llmClient.chat(
              mikePrompt.system,
              retryPrompt,
              { jsonMode: true, temperature: 0.8 }
            );

            response = response.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            analysis = JSON.parse(response);
          }

          // 7. Validation du schéma de base
          if (!analysis.verdict_global || !analysis.participants || !Array.isArray(analysis.participants)) {
            throw new Error('Schéma de réponse invalide');
          }

          console.log(`✅ Analyse terminée : ${analysis.participants.length} participants analysés`);

          // 8. Ajouter les statistiques détaillées de la conversation
          analysis.conversationStats = {
            totalMessages: stats.totalMessages,
            participantCount: stats.participantCount,
            participants: stats.participants,
            dateRange: stats.dateRange,
            durationMonths: stats.durationMonths
          };

          // 9. Réponse au client
          res.json({
            success: true,
            stats: {
              totalMessages: stats.totalMessages,
              participantCount: stats.participantCount,
              participants: stats.participants,
              dateRange: stats.dateRange,
              durationMonths: stats.durationMonths
            },
            analysis
          });

          resolve();

        } catch (error) {
          console.error('❌ Erreur:', error.message);
          console.error('   Stack:', error.stack);
          
          // Réponse d'erreur sans détails sensibles
          res.status(500).json({
            error: 'Erreur lors de l\'analyse',
            message: error.message.includes('API') || error.message.includes('clé')
              ? 'Erreur de configuration du serveur (clé API)'
              : 'Impossible de traiter la conversation',
            debug: process.env.NODE_ENV === 'development' ? error.message : undefined
          });

          resolve();

        } finally {
          // Nettoyage du fichier temporaire
          if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
              fs.unlinkSync(tempFilePath);
            } catch (cleanupError) {
              console.warn('⚠️ Erreur nettoyage fichier:', cleanupError.message);
            }
          }
        }
      }
    };

    analysisQueue.push(task);
    processAnalysisQueue();
  });
});

/**
 * Chat endpoint for AI assistant
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message vide' });
    }

    const llmClient = new LLMClient();

    const systemPrompt = `Tu es l'assistant virtuel de Mike, un site web qui analyse les conversations WhatsApp de manière humoristique.

🎯 TON RÔLE :
- Répondre aux questions des utilisateurs sur le fonctionnement de Mike
- Être amical, accessible et utile
- Expliquer comment utiliser le site
- Donner des informations sur l'analyse des conversations

📱 FONCTIONNALITÉS DE MIKE :
1. Upload d'un fichier .zip (export WhatsApp)
2. Analyse automatique des conversations avec IA
3. Rapport détaillé avec :
   - Vue d'ensemble de la conversation
   - Profil de chaque participant (personnalité, tics de langage, comportements)
   - Awards humoristiques (MVP, Most Dramatic, etc.)
   - Verdict final style "dossier d'investigation"

💡 COMMENT UTILISER MIKE :
1. Sur WhatsApp : Ouvrir une conversation > Menu (⋮) > Plus > Exporter la conversation
2. Choisir "Sans médias" (recommandé)
3. Télécharger le fichier .zip
4. Aller sur Mike et uploader le .zip
5. Attendre l'analyse (quelques secondes)
6. Consulter le rapport détaillé !

🔒 CONFIDENTIALITÉ :
- Aucune donnée n'est stockée après l'analyse
- Traitement 100% éphémère
- Fichiers supprimés automatiquement

⚠️ LIMITES :
- Fichier .zip uniquement (export WhatsApp)
- Taille max : 50 MB
- Conversations en français recommandées

👨‍💻 CRÉATEUR :
- Ce site a été créé par Issa.dev (développeur professionnel)
- Si on te demande qui a créé Mike, mentionne Issa.dev

Réponds de manière concise et naturelle. Sois drôle quand approprié. Utilise des emojis pour rendre ça plus vivant !`;

    const userMessage = message;

    const response = await llmClient.chat(
      systemPrompt,
      userMessage,
      { 
        temperature: 0.9, 
        maxTokens: 500 
      }
    );

    res.json({ 
      success: true, 
      response 
    });

  } catch (error) {
    console.error('❌ Erreur chat:', error.message);
    res.status(500).json({ 
      error: 'Erreur lors du chat',
      message: 'Impossible de générer une réponse. Réessaie dans un instant.'
    });
  }
});

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    provider: process.env.LLM_PROVIDER || 'mistral'
  });
});

// Middleware de gestion d'erreur Multer (DOIT être après les routes)
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    console.error('❌ Erreur Multer:', error.message);
    return res.status(400).json({ 
      error: 'Erreur lors de l\'upload',
      message: error.code === 'LIMIT_FILE_SIZE' 
        ? 'Fichier trop volumineux (max 50 MB)'
        : error.message
    });
  } else if (error) {
    console.error('❌ Erreur upload:', error.message);
    return res.status(400).json({ 
      error: error.message 
    });
  }
  next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur Mike démarré sur le port ${PORT}`);
  console.log(`📡 Accessible sur le réseau à http://0.0.0.0:${PORT}`);
  console.log(`📡 Providers LLM: Groq (prioritaire) + Mistral (fallback)`);
});
