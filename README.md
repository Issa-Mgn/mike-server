# Mike — Analyseur de conversations WhatsApp

Application web qui analyse un export de conversation WhatsApp et génère un rapport IA humoristique et cash sur chaque participant.

## Stack Technique

### Frontend
- **React** (Vite)
- **CSS pur** avec variables CSS
- Design "dossier d'investigation" (évite les clichés IA)

### Backend
- **Node.js + Express**
- **LLM** : Support interchangeable Mistral AI / Groq
- Parsing WhatsApp, chunking intelligent, gestion tokens
- Aucune donnée stockée après traitement

## Installation

### 1. Backend

```bash
cd server
npm install
```

Créer un fichier `.env` à la racine du dossier `server` :

```env
# LLM Provider: 'mistral' ou 'groq'
LLM_PROVIDER=mistral

# Clés API
MISTRAL_API_KEY=ta_cle_mistral
GROQ_API_KEY=ta_cle_groq

# Port serveur
PORT=3001
```

Lancer le serveur :

```bash
npm run dev
```

### 2. Frontend

```bash
cd mike
npm install
npm run dev
```

L'app sera disponible sur `http://localhost:5173`

## Utilisation

1. Exporter une conversation WhatsApp :
   - Ouvrir la discussion
   - Cliquer sur ⋮ (menu)
   - Plus → Exporter la discussion → **Sans média**
   - Récupérer le fichier `.zip`

2. Upload le `.zip` sur l'app Mike

3. Attendre l'analyse (jusqu'à 30 secondes)

4. Consulter le rapport détaillé avec :
   - Verdict global du groupe
   - Fiches individuelles (note, rôle, tics, moments révélateurs)
   - Awards humoristiques
   - Dynamiques cachées
   - Verdict final (punchline)

## Architecture

```
├── mike/              # Frontend React
│   ├── src/
│   │   ├── App.jsx           # Composant principal
│   │   ├── App.css           # Design "dossier d'investigation"
│   │   └── index.css         # Design system (variables CSS)
│   └── public/
│
└── server/            # Backend Node.js
    ├── services/
    │   └── llmClient.js      # Client abstrait Mistral/Groq
    ├── prompts/
    │   └── mikePrompt.js     # Prompt système "Mike"
    ├── utils/
    │   ├── whatsappParser.js # Parse les exports WhatsApp
    │   └── tokenCounter.js   # Chunking intelligent
    └── server.js             # Serveur Express principal
```

## Sécurité & Confidentialité

- Aucune donnée stockée côté serveur après traitement
- Fichiers temporaires supprimés immédiatement après analyse
- Pas de logs du contenu des conversations
- Clés API uniquement en `.env`, jamais en dur dans le code

## Design

Direction "dossier d'investigation", pas landing page SaaS :
- Palette vintage réattribuée par fonction
- Typographie : Fraunces (display), Inter (body), JetBrains Mono (technique)
- Fiches participants présentées comme des onglets de dossier
- Notes affichées comme des tampons encreurs pivotés
- Citations surlignées comme des pièces à conviction
- Respect `prefers-reduced-motion` pour accessibilité

## Limitations MVP

- Format WhatsApp uniquement (pas iMessage)
- Pas de base de données
- Pas de système de paiement
- Usage personnel uniquement

## License

Projet personnel - Tous droits réservés
