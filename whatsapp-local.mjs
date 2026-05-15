import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RAILWAY_URL = 'https://paineldecobrancas-production.up.railway.app';

const TEMPLATES = {
  aviso: (nome, valor, venc) =>
    `Olá *${nome}*! 👋\n\nPassando para lembrar que você tem um boleto no valor de *R$ ${valor}* com vencimento *amanhã (${venc})*.\n\nEfetue o pagamento para evitar juros e multas.\n\n_Mensagem automática — não responda._`,
  vencimento: (nome, valor, venc) =>
    `Olá *${nome}*! 👋\n\nSeu boleto no valor de *R$ ${valor}* vence *hoje (${venc})*.\n\nEfetue o pagamento ainda hoje para evitar multas.\n\n_Mensagem automática — não responda._`,
  atraso: (nome, valor, venc, dias) =>
    `Olá *${nome}*! ⚠️\n\nIdentificamos que seu boleto de *R$ ${valor}* (vencimento: ${venc}) está em atraso há *${dias} dia${dias > 1 ? 's' : ''}*.\n\nEntre em contato para regularizar sua situação.\n\n_Mensagem automática — não responda._`
};

function normalizarTel(tel) {
  const d = tel.replace(/\D/g, '');
  return (d.startsWith('55') && d.length >= 12) ? d : '55' + d;
}

function parseDate(str) {
  if (!str) return null;
  const [d, m, y] = str.split('/');
  if (!d || !m || !y) return null;
  return new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
}

async function apiFetch(path) {
  const res = await fetch(`${RAILWAY_URL}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${path}`);
  return res.json();
}

async function enviarCobrancas(sock, tipo) {
  console.log('\nBuscando dados do Railway...');
  const [{ payments }, { companies }] = await Promise.all([
    apiFetch('/api/payments?limit=2000'),
    apiFetch('/api/companies')
  ]);

  const companyMap = {};
  companies.forEach(c => { companyMap[c.cnpj] = c; });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const pendentes = payments.filter(p => p.ocorrencia.includes('02'));
  let enviados = 0, pulados = 0, erros = 0;

  for (const p of pendentes) {
    const venc = parseDate(p.dataVencimento);
    if (!venc) { pulados++; continue; }

    const diff = Math.round((venc - today) / 86400000);
    const deve = (tipo === 'aviso' && diff === 1) ||
                 (tipo === 'vencimento' && diff === 0) ||
                 (tipo === 'atraso' && diff < 0);
    if (!deve) { pulados++; continue; }

    const cnpj = p.pagador.split(' - ')[0]?.trim();
    const company = companyMap[cnpj];
    if (!company?.telefone) { pulados++; continue; }

    const tel = normalizarTel(company.telefone);
    if (tel.length < 12) { pulados++; continue; }

    const valor = p.valorBoleto.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const msg = tipo === 'aviso'      ? TEMPLATES.aviso(company.nome, valor, p.dataVencimento)
              : tipo === 'vencimento' ? TEMPLATES.vencimento(company.nome, valor, p.dataVencimento)
              :                         TEMPLATES.atraso(company.nome, valor, p.dataVencimento, Math.abs(diff));

    try {
      await sock.sendMessage(`${tel}@s.whatsapp.net`, { text: msg });
      console.log(`  ✅ ${company.nome} (${tel})`);
      enviados++;
      await new Promise(r => setTimeout(r, 1500)); // evitar ban por flood
    } catch (err) {
      console.log(`  ❌ ${company.nome}: ${err.message}`);
      erros++;
    }
  }

  console.log(`\nResultado: ${enviados} enviados | ${erros} erros | ${pulados} pulados\n`);
}

async function menu(sock) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(r => rl.question(q, r));

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   AGENTE DE COBRANÇAS — WHATSAPP     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('  1 → Avisos    (vence amanhã)');
  console.log('  2 → Vencendo  (vence hoje)');
  console.log('  3 → Atrasos   (vencidos)');
  console.log('  0 → Sair\n');

  while (true) {
    const op = (await ask('Opção: ')).trim();
    if (op === '1') await enviarCobrancas(sock, 'aviso');
    else if (op === '2') await enviarCobrancas(sock, 'vencimento');
    else if (op === '3') await enviarCobrancas(sock, 'atraso');
    else if (op === '0') { rl.close(); process.exit(0); }
    else console.log('Opção inválida.');
  }
}

async function main() {
  const sessionPath = path.join(__dirname, 'data', 'wpp-session-local');
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['Painel Cobranças', 'Chrome', '1.0.0'],
    logger: { level: 'silent', trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){}, child(){ return this; } }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log('\nEscaneie o QR Code acima com o WhatsApp do celular...\n');

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('\nSessão encerrada. Removendo dados locais...');
        fs.rmSync(sessionPath, { recursive: true, force: true });
      } else {
        console.log('\nConexão perdida. Reinicie com: node whatsapp-local.mjs');
      }
      process.exit(0);
    }

    if (connection === 'open') {
      console.log('\n✅ WhatsApp conectado!\n');
      await menu(sock);
    }
  });
}

main().catch(err => { console.error('Erro fatal:', err.message); process.exit(1); });
