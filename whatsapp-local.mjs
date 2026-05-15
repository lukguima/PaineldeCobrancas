import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RAILWAY_URL = 'https://paineldecobrancas-production.up.railway.app';
const LOCAL_PORT  = 3001;

let wppClient = null;
let wppStatus  = 'disconnected';
let wppQr      = null;
let sendLog    = [];

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

async function initWhatsApp() {
  try {
    if (wppClient) { try { wppClient.end(); } catch {} wppClient = null; }

    wppStatus = 'connecting';
    wppQr     = null;

    const { default: QRCode } = await import('qrcode');
    const sessionPath = path.join(__dirname, 'data', 'wpp-session-local');
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      browser: ['Painel Cobranças', 'Chrome', '1.0.0'],
      logger: { level:'silent', trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){}, child(){ return this; } }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        wppStatus = 'qr';
        try { wppQr = await QRCode.toDataURL(qr); } catch {}
        console.log('\n[WPP] QR gerado — escaneie pelo dashboard ou pelo terminal acima.\n');
      }
      if (connection === 'open') {
        wppStatus = 'ready';
        wppQr     = null;
        console.log('[WPP] ✅ WhatsApp conectado!');
      }
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          wppStatus = 'disconnected';
          wppClient = null;
          const sessionPath = path.join(__dirname, 'data', 'wpp-session-local');
          fs.rmSync(sessionPath, { recursive: true, force: true });
          console.log('[WPP] Sessão encerrada (logout).');
        } else {
          console.log('[WPP] Conexão caiu, reconectando em 5s...');
          setTimeout(() => initWhatsApp(), 5000);
        }
      }
    });

    wppClient = sock;
  } catch (err) {
    console.error('[WPP] Erro:', err.message);
    wppStatus = 'error';
  }
}

async function enviarCobrancas(tipo) {
  if (wppStatus !== 'ready' || !wppClient)
    return { enviados: 0, erros: 0, pulados: 0, erro: 'WhatsApp não conectado' };

  const [paymentsRes, companiesRes] = await Promise.all([
    fetch(`${RAILWAY_URL}/api/payments?limit=2000`).then(r => r.json()),
    fetch(`${RAILWAY_URL}/api/companies`).then(r => r.json())
  ]);

  const payments  = paymentsRes.payments  || [];
  const companies = companiesRes.companies || [];
  const companyMap = {};
  companies.forEach(c => { companyMap[c.cnpj] = c; });

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];
  const jaEnviados = new Set(sendLog.filter(l => l.data === todayStr).map(l => `${l.nossoNumero}_${l.tipo}`));

  const pendentes = payments.filter(p => p.ocorrencia.includes('02'));
  let enviados = 0, erros = 0, pulados = 0;

  for (const p of pendentes) {
    const venc = parseDate(p.dataVencimento);
    if (!venc) { pulados++; continue; }

    const diff = Math.round((venc - today) / 86400000);
    const deve = (tipo === 'aviso' && diff === 1) ||
                 (tipo === 'vencimento' && diff === 0) ||
                 (tipo === 'atraso' && diff < 0);
    if (!deve) { pulados++; continue; }

    const chave = `${p.nossoNumero}_${tipo}`;
    if (jaEnviados.has(chave)) { pulados++; continue; }

    const cnpj    = p.pagador.split(' - ')[0]?.trim();
    const company = companyMap[cnpj];
    if (!company?.telefone) { pulados++; continue; }

    const tel = normalizarTel(company.telefone);
    if (tel.length < 12) { pulados++; continue; }

    const valor = p.valorBoleto.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const dias  = Math.abs(diff);
    const msg   = tipo === 'aviso'      ? TEMPLATES.aviso(company.nome, valor, p.dataVencimento)
                : tipo === 'vencimento' ? TEMPLATES.vencimento(company.nome, valor, p.dataVencimento)
                :                         TEMPLATES.atraso(company.nome, valor, p.dataVencimento, dias);

    try {
      await wppClient.sendMessage(`${tel}@s.whatsapp.net`, { text: msg });
      const entry = { nossoNumero: p.nossoNumero, tipo, data: todayStr, telefone: tel, nome: company.nome, valor: p.valorBoleto, vencimento: p.dataVencimento, sentAt: new Date().toISOString() };
      sendLog.unshift(entry);
      sendLog = sendLog.slice(0, 200);
      jaEnviados.add(chave);
      enviados++;
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      erros++;
    }
  }

  return { enviados, erros, pulados };
}

/* ===== API LOCAL ===== */

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/status',      (req, res) => res.json({ status: wppStatus }));
app.get('/qr',          (req, res) => wppQr ? res.json({ qr: wppQr }) : res.status(404).json({ error: 'QR não disponível' }));
app.get('/log',         (req, res) => res.json({ log: sendLog.slice(0, 100) }));
app.post('/connect',    (req, res) => { if (wppStatus === 'disconnected' || wppStatus === 'error') initWhatsApp(); res.json({ status: wppStatus }); });
app.post('/disconnect', async (req, res) => {
  try { if (wppClient) { await wppClient.logout(); wppClient.end(); } } catch {}
  wppClient = null; wppStatus = 'disconnected'; wppQr = null;
  res.json({ success: true });
});
app.post('/enviar', async (req, res) => {
  const tipo = req.query.tipo;
  if (!['aviso', 'vencimento', 'atraso'].includes(tipo))
    return res.status(400).json({ error: 'tipo inválido' });
  try {
    const result = await enviarCobrancas(tipo);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(LOCAL_PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Agente WhatsApp rodando na porta ${LOCAL_PORT}   ║`);
  console.log(`║  Abra o dashboard e clique em Conectar  ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  initWhatsApp();
});
