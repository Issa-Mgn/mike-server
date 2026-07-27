/**
 * Client LLM avec rotation automatique entre plusieurs clés API
 * Supporte : Groq, Mistral, Hugging Face
 */

const https = require('https');

class LLMClient {
  constructor() {
    // Charger toutes les clés disponibles
    this.groqKeys = this._loadKeys('GROQ_API_KEY');
    this.mistralKeys = this._loadKeys('MISTRAL_API_KEY');
    this.hfKeys = this._loadKeys('HUGGINGFACE_API_KEY');
    
    // Index de rotation
    this.groqIndex = 0;
    this.mistralIndex = 0;
    this.hfIndex = 0;
    
    // Configuration
    this.providers = {
      groq: {
        apiUrl: 'api.groq.com',
        model: 'llama-3.3-70b-versatile',
        path: '/openai/v1/chat/completions',
        type: 'openai'
      },
      mistral: {
        apiUrl: 'api.mistral.ai',
        model: 'mistral-large-latest',
        path: '/v1/chat/completions',
        type: 'openai'
      },
      huggingface: {
        apiUrl: 'huggingface.co',
        model: 'Qwen/Qwen2.5-72B-Instruct',
        path: '/api/models/Qwen/Qwen2.5-72B-Instruct/v1/chat/completions',
        type: 'openai'
      }
    };
    
    const totalKeys = this.groqKeys.length + this.mistralKeys.length + this.hfKeys.length;
    if (totalKeys === 0) {
      throw new Error('Aucune clé API configurée');
    }
    
    console.log(`🔑 ${this.groqKeys.length} clés Groq | ${this.mistralKeys.length} clés Mistral | ${this.hfKeys.length} clés HuggingFace`);
  }
  
  /**
   * Charger toutes les clés d'un provider depuis les env vars
   */
  _loadKeys(prefix) {
    const keys = [];
    
    // Essayer sans suffix d'abord (backward compatibility)
    const mainKey = process.env[prefix];
    if (mainKey && mainKey.trim()) {
      keys.push(mainKey.trim());
    }
    
    // Essayer avec suffix _1, _2, _3, etc.
    for (let i = 1; i <= 10; i++) {
      const key = process.env[`${prefix}_${i}`];
      if (key && key.trim()) {
        keys.push(key.trim());
      }
    }
    
    return [...new Set(keys)]; // Dédupliquer
  }
  
  /**
   * Obtenir la prochaine clé disponible pour un provider
   */
  _getNextKey(providerName) {
    if (providerName === 'groq') {
      if (this.groqKeys.length === 0) return null;
      const key = this.groqKeys[this.groqIndex];
      this.groqIndex = (this.groqIndex + 1) % this.groqKeys.length;
      return key;
    } else if (providerName === 'mistral') {
      if (this.mistralKeys.length === 0) return null;
      const key = this.mistralKeys[this.mistralIndex];
      this.mistralIndex = (this.mistralIndex + 1) % this.mistralKeys.length;
      return key;
    } else if (providerName === 'huggingface') {
      if (this.hfKeys.length === 0) return null;
      const key = this.hfKeys[this.hfIndex];
      this.hfIndex = (this.hfIndex + 1) % this.hfKeys.length;
      return key;
    }
    return null;
  }

  /**
   * Appel avec rotation automatique des clés
   */
  async chat(systemPrompt, userMessage, options = {}) {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];

    // Essayer toutes les clés dans l'ordre : Groq > Mistral > HuggingFace
    const providers = [
      { name: 'groq', keys: this.groqKeys },
      { name: 'mistral', keys: this.mistralKeys },
      { name: 'huggingface', keys: this.hfKeys }
    ];

    for (const provider of providers) {
      for (let i = 0; i < provider.keys.length; i++) {
        try {
          console.log(`🔄 ${provider.name.toUpperCase()} clé ${i + 1}/${provider.keys.length}...`);
          return await this._makeRequestWithProvider(provider.name, messages, options);
        } catch (error) {
          if (!error.message.includes('429') && !error.message.includes('413') && !error.message.includes('503')) {
            throw error; // Erreur non liée au rate limit
          }
          console.log(`   ⚠️  ${provider.name} clé ${i + 1} limitée`);
        }
      }
    }
    
    throw new Error('Toutes les clés API sont limitées. Réessayez dans 1 heure ou ajoutez plus de clés.');
  }

  /**
   * Faire une requête avec un provider spécifique
   */
  async _makeRequestWithProvider(providerName, messages, options = {}) {
    const config = this.providers[providerName];
    const apiKey = this._getNextKey(providerName);
    
    if (!apiKey) {
      throw new Error(`Aucune clé ${providerName} disponible`);
    }

    const payload = {
      model: config.model,
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 4000
    };

    if (options.jsonMode && providerName !== 'huggingface') {
      payload.response_format = { type: 'json_object' };
    }

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: config.apiUrl,
        path: config.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      };

      const req = https.request(requestOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.choices[0].message.content);
            } catch (e) {
              reject(new Error('Réponse JSON invalide'));
            }
          } else {
            reject(new Error(`Erreur API ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  /**
   * Extrait les moments notables d'un chunk (citations exactes, pas de résumé)
   */
  async extractMoments(messages, chunkIndex, totalChunks) {
    const systemPrompt = `Tu es un détective d'analyse conversationnelle. Tu reçois une portion chronologique d'une conversation WhatsApp. Ta mission : capturer un MAXIMUM de moments notables, tics, patterns et citations pour permettre une analyse complète.

🎯 EXTRAIS TOUT CE QUI EST NOTABLE :
- Phrases drôles, punchlines, réponses comiques
- Tics de langage (expressions récurrentes, emojis répétés, tournures caractéristiques)
- Contradictions entre messages
- Moments révélateurs ou gênants
- Running gags
- Patterns de comportement (horaires de message, temps de réponse, sujets évités/préférés)
- Citations mémorables ou insolites
- Réactions émotionnelles fortes

📊 ANALYSE AUSSI :
- Qui initie les conversations vs qui répond
- Longueur des messages (quelqu'un qui écrit toujours beaucoup/peu)
- Changements de ton ou de sujet
- Silences significatifs ou absences

⚠️ RÈGLES CRITIQUES :
- Cite le texte EXACT, jamais une reformulation
- Sois EXHAUSTIF : mieux vaut trop de moments que pas assez
- Chaque tic de langage récurrent DOIT être capturé avec une citation
- Indique l'auteur exact et le timestamp quand disponible
- Ne filtre pas trop : même les petits détails peuvent être révélateurs

RÉPONDS UNIQUEMENT EN JSON VALIDE :

{
  "moments": [
    {
      "auteur": "string",
      "citation": "string, texte EXACT",
      "categorie": "drole | gênant | contradiction | running_gag | tic_de_langage | comportement | pattern | reaction",
      "pourquoi_notable": "string",
      "timestamp": "string ou null"
    }
  ],
  "patterns_observes": {
    "tics_de_langage_detectes": ["liste des expressions répétées par personne"],
    "comportements_remarques": ["observations comportementales"]
  }
}`;

    // Échantillonner moins agressivement pour garder plus de contexte
    const sample = messages.length > 200 
      ? messages.filter((_, i) => i % Math.ceil(messages.length / 200) === 0)
      : messages;

    const userMessage = `Extrait ${chunkIndex + 1}/${totalChunks} (${sample.length} messages échantillonnés sur ${messages.length}) :\n\n${JSON.stringify(sample, null, 2)}`;
    
    return await this.chat(systemPrompt, userMessage, { 
      jsonMode: true,
      temperature: 0.4, 
      maxTokens: 1500  // Plus de tokens pour capturer plus de moments
    });
  }
}

module.exports = LLMClient;
