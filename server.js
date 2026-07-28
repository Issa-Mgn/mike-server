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

// Tracking des IPs pour limite quotidienne (3 analyses/jour/IP)
// Format: { ip: { analyses: [{timestamp, resetAt}], count: number } }
const ipTracking = new Map();

const MAX_ANALYSES_PER_DAY = 3; // Limite de 3 analyses par jour

// 🔄 RESET COMPLET au démarrage du serveur
console.log('🧹 Reset complet de toutes les IPs enregistrées au démarrage');
ipTracking.clear();

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

// Nettoyer les IPs expirées toutes les heures
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of ipTracking.entries()) {
    // Filtrer les analyses expirées (plus de 24h)
    data.analyses = data.analyses.filter(analysis => now < analysis.resetAt);
    data.count = data.analyses.length;
    
    // Si plus aucune analyse active, supprimer l'IP
    if (data.analyses.length === 0) {
      ipTracking.delete(ip);
      console.log(`🧹 Reset limite IP: ${ip}`);
    }
  }
}, 60 * 60 * 1000); // Check toutes les heures

/**
 * Obtenir l'IP du client
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || 
         req.headers['x-real-ip'] ||
         req.socket.remoteAddress ||
         req.connection.remoteAddress;
}

/**
 * Vérifier si l'IP peut faire une analyse
 */
function canAnalyze(ip) {
  const now = Date.now();
  const tracking = ipTracking.get(ip);
  
  if (!tracking) {
    return { 
      allowed: true, 
      remainingTime: 0, 
      remainingAnalyses: MAX_ANALYSES_PER_DAY,
      usedAnalyses: 0
    };
  }
  
  // Filtrer les analyses qui ne sont pas encore expirées
  const activeAnalyses = tracking.analyses.filter(analysis => now < analysis.resetAt);
  
  // Mettre à jour le tracking
  tracking.analyses = activeAnalyses;
  tracking.count = activeAnalyses.length;
  
  // Si on a atteint la limite
  if (activeAnalyses.length >= MAX_ANALYSES_PER_DAY) {
    // Trouver l'analyse la plus ancienne pour calculer quand elle expirera
    const oldestAnalysis = activeAnalyses.sort((a, b) => a.timestamp - b.timestamp)[0];
    const remainingTime = oldestAnalysis.resetAt - now;
    
    return { 
      allowed: false, 
      remainingTime,
      remainingAnalyses: 0,
      usedAnalyses: activeAnalyses.length,
      nextResetAt: oldestAnalysis.resetAt
    };
  }
  
  // Sinon, autoriser
  return { 
    allowed: true, 
    remainingTime: 0,
    remainingAnalyses: MAX_ANALYSES_PER_DAY - activeAnalyses.length,
    usedAnalyses: activeAnalyses.length
  };
}

/**
 * Enregistrer une analyse pour une IP
 */
function recordAnalysis(ip) {
  const now = Date.now();
  const resetAt = now + (24 * 60 * 60 * 1000); // +24 heures
  
  const tracking = ipTracking.get(ip) || { analyses: [], count: 0 };
  
  // Ajouter la nouvelle analyse
  tracking.analyses.push({
    timestamp: now,
    resetAt: resetAt
  });
  
  tracking.count = tracking.analyses.length;
  
  ipTracking.set(ip, tracking);
  
  const resetDate = new Date(resetAt);
  console.log(`📊 Analyse ${tracking.count}/${MAX_ANALYSES_PER_DAY} enregistrée pour IP: ${ip}, expire à ${resetDate.toISOString()}`);
}

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
 * Health check - Route légère pour UptimeRobot
 * Utilisée pour garder le serveur actif et éviter le cold start
 */
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    provider: process.env.LLM_PROVIDER || 'mistral',
    activeAnalysis: activeAnalysis,
    queueLength: analysisQueue.length
  });
});

/**
 * Ping endpoint ultra-léger pour UptimeRobot (alternative)
 */
app.get('/ping', (req, res) => {
  res.send('pong');
});

/**
 * Vérifier si l'utilisateur peut faire une analyse (limite quotidienne)
 */
app.get('/api/can-analyze', (req, res) => {
  const ip = getClientIp(req);
  const { allowed, remainingTime, remainingAnalyses, usedAnalyses, nextResetAt } = canAnalyze(ip);
  
  res.json({
    allowed,
    remainingTime,
    remainingAnalyses,
    usedAnalyses,
    maxAnalysesPerDay: MAX_ANALYSES_PER_DAY,
    nextResetAt,
    ip: process.env.NODE_ENV === 'development' ? ip : undefined // Debug only
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
 * Vérifier le statut d'une analyse
 */
app.get('/api/analysis/:analysisId/status', (req, res) => {
  const { analysisId } = req.params;
  
  const analysis = analysisResults.get(analysisId);
  
  if (!analysis) {
    return res.status(404).json({ 
      status: 'not_found',
      message: 'Analyse introuvable ou expirée' 
    });
  }
  
  res.json({
    status: analysis.status,
    hasResult: analysis.status === 'completed'
  });
});

/**
 * Récupérer les résultats d'une analyse terminée
 */
app.get('/api/analysis/:analysisId/result', (req, res) => {
  const { analysisId } = req.params;
  
  const analysis = analysisResults.get(analysisId);
  
  if (!analysis) {
    return res.status(404).json({ 
      error: 'Analyse introuvable ou expirée' 
    });
  }
  
  if (analysis.status !== 'completed') {
    return res.status(400).json({ 
      error: 'Analyse non terminée',
      status: analysis.status 
    });
  }
  
  // Retourner le résultat et le supprimer
  const result = analysis.result;
  analysisResults.delete(analysisId);
  
  res.json(result);
});

/**
 * Endpoint principal : analyse d'une conversation WhatsApp
 * Utilise une queue pour gérer jusqu'à 50 requêtes simultanées
 * Retourne immédiatement un analysisId pour permettre le polling
 */
app.post('/api/analyze', upload.single('conversation'), async (req, res) => {
  // Vérifier la limite quotidienne par IP
  const ip = getClientIp(req);
  const { allowed, remainingTime, lastAnalysis } = canAnalyze(ip);
  
  if (!allowed) {
    console.log(`🚫 Limite atteinte pour IP: ${ip}, reste ${Math.floor(remainingTime / 1000 / 60)} minutes`);
    return res.status(429).json({
      error: 'Limite quotidienne atteinte',
      message: 'Vous avez déjà effectué une analyse aujourd\'hui. Revenez demain !',
      remainingTime,
      lastAnalysis,
      resetAt: lastAnalysis + (24 * 60 * 60 * 1000)
    });
  }
  
  // Générer un ID unique pour cette analyse
  const analysisId = require('crypto').randomUUID();
  
  console.log(`📥 Nouvelle analyse créée: ${analysisId} (IP: ${ip})`);
  console.log('   Fichier:', req.file ? req.file.originalname : 'aucun');
  
  if (!req.file) {
    console.log('❌ Aucun fichier uploadé');
    return res.status(400).json({ error: 'Aucun fichier uploadé' });
  }
  
  // Enregistrer l'analyse pour cette IP
  recordAnalysis(ip);
  
  // Initialiser le statut de l'analyse
  analysisResults.set(analysisId, {
    status: 'pending',
    result: null,
    timestamp: Date.now()
  });
  
  // Retourner immédiatement l'ID au client
  res.json({
    success: true,
    analysisId: analysisId,
    message: 'Analyse démarrée'
  });
  
  // Ajouter la tâche d'analyse à la queue
  const task = {
    process: async () => {
      let tempFilePath = req.file.path;

      try {
        console.log(`🔄 Traitement analyse ${analysisId} (Active:`, activeAnalysis, '/ Queue:', analysisQueue.length, ')');
        
        // Mettre à jour le statut
        const analysisData = analysisResults.get(analysisId);
        if (analysisData) {
          analysisData.status = 'processing';
        }

        // 1. Dézipper et extraire le .txt
        const zip = new AdmZip(tempFilePath);
        const zipEntries = zip.getEntries();
        
        const txtEntry = zipEntries.find(entry => 
          entry.entryName.endsWith('.txt') && !entry.isDirectory
        );

        if (!txtEntry) {
          const analysisEntry = analysisResults.get(analysisId);
          if (analysisEntry) {
            analysisEntry.status = 'error';
            analysisEntry.result = { 
              error: 'Aucun fichier .txt trouvé dans le .zip. Assurez-vous d\'avoir exporté correctement votre conversation WhatsApp.' 
            };
            analysisEntry.timestamp = Date.now();
          }
          return null;
        }

        const txtContent = txtEntry.getData().toString('utf8');

        // 2. Parser le contenu WhatsApp
        const messages = parseWhatsAppExport(txtContent);

        if (messages.length === 0) {
          const analysisEntry = analysisResults.get(analysisId);
          if (analysisEntry) {
            analysisEntry.status = 'error';
            analysisEntry.result = { 
              error: 'Aucun message valide détecté. Vérifiez que le fichier est bien un export WhatsApp.' 
            };
            analysisEntry.timestamp = Date.now();
          }
          return null;
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

        console.log(`✅ Analyse ${analysisId} terminée : ${analysis.participants.length} participants analysés`);

        // 8. Ajouter les statistiques détaillées de la conversation
        analysis.conversationStats = {
          totalMessages: stats.totalMessages,
          participantCount: stats.participantCount,
          participants: stats.participants,
          dateRange: stats.dateRange,
          durationMonths: stats.durationMonths
        };

        // 9. Stocker le résultat dans le Map
        const resultData = {
          success: true,
          stats: {
            totalMessages: stats.totalMessages,
            participantCount: stats.participantCount,
            participants: stats.participants,
            dateRange: stats.dateRange,
            durationMonths: stats.durationMonths
          },
          analysis
        };
        
        const analysisEntry = analysisResults.get(analysisId);
        if (analysisEntry) {
          analysisEntry.status = 'completed';
          analysisEntry.result = resultData;
          analysisEntry.timestamp = Date.now();
        }
        
        console.log(`💾 Résultat ${analysisId} sauvegardé et prêt`);
        
        return resultData;

      } catch (error) {
        console.error(`❌ Erreur analyse ${analysisId}:`, error.message);
        console.error('   Stack:', error.stack);
        
        // Stocker l'erreur dans le Map
        const analysisEntry = analysisResults.get(analysisId);
        if (analysisEntry) {
          analysisEntry.status = 'error';
          analysisEntry.result = {
            error: 'Erreur lors de l\'analyse',
            message: error.message.includes('API') || error.message.includes('clé')
              ? 'Erreur de configuration du serveur (clé API)'
              : 'Impossible de traiter la conversation',
            debug: process.env.NODE_ENV === 'development' ? error.message : undefined
          };
          analysisEntry.timestamp = Date.now();
        }
        
        return null;

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
