/**
 * Script pour créer un fichier .zip de test WhatsApp
 * Usage: node create-test-zip.js
 */

const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

console.log('📦 Création du fichier de test...\n');

const zip = new AdmZip();

// Vérifier que le fichier exemple existe
const exempleFile = path.join(__dirname, 'exemple_whatsapp.txt');

if (!fs.existsSync(exempleFile)) {
  console.error('❌ Fichier exemple_whatsapp.txt introuvable !');
  process.exit(1);
}

// Ajouter le fichier au zip
zip.addLocalFile(exempleFile);

// Sauvegarder le zip
const outputPath = path.join(__dirname, 'test_whatsapp.zip');
zip.writeZip(outputPath);

console.log(`✅ Fichier créé : ${outputPath}`);
console.log('\nVous pouvez maintenant l\'uploader sur Mike pour tester l\'app !\n');
