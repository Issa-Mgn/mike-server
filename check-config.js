/**
 * Script de vérification de la configuration
 * Lance-le avant de démarrer le serveur : node check-config.js
 */

require('dotenv').config();

console.log('\n🔍 Vérification de la configuration Mike...\n');

let errors = [];
let warnings = [];

// Vérifier le provider
const provider = process.env.LLM_PROVIDER || 'mistral';
console.log(`✓ Provider LLM: ${provider}`);

if (!['mistral', 'groq'].includes(provider)) {
  errors.push(`Provider "${provider}" non supporté. Utiliser 'mistral' ou 'groq'`);
}

// Vérifier les clés API
if (provider === 'mistral') {
  if (!process.env.MISTRAL_API_KEY) {
    errors.push('MISTRAL_API_KEY manquante dans .env');
  } else if (process.env.MISTRAL_API_KEY.trim() === '') {
    errors.push('MISTRAL_API_KEY vide dans .env');
  } else {
    console.log('✓ Clé API Mistral configurée');
  }
} else if (provider === 'groq') {
  if (!process.env.GROQ_API_KEY) {
    errors.push('GROQ_API_KEY manquante dans .env');
  } else if (process.env.GROQ_API_KEY.trim() === '') {
    errors.push('GROQ_API_KEY vide dans .env');
  } else {
    console.log('✓ Clé API Groq configurée');
  }
}

// Vérifier le port
const port = process.env.PORT || 3001;
console.log(`✓ Port serveur: ${port}`);

// Vérifier l'existence du dossier uploads
const fs = require('fs');
if (!fs.existsSync('uploads')) {
  warnings.push('Dossier "uploads" absent (sera créé automatiquement au premier upload)');
}

// Afficher le résultat
console.log('\n' + '='.repeat(50) + '\n');

if (errors.length > 0) {
  console.log('❌ ERREURS:\n');
  errors.forEach(error => console.log(`  • ${error}`));
  console.log('\n');
  process.exit(1);
}

if (warnings.length > 0) {
  console.log('⚠️  AVERTISSEMENTS:\n');
  warnings.forEach(warning => console.log(`  • ${warning}`));
  console.log('\n');
}

console.log('✅ Configuration valide ! Vous pouvez lancer le serveur avec "npm run dev"\n');
process.exit(0);
