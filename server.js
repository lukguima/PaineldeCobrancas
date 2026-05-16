const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;

/* ===== STORAGE: MongoDB (produção) ou JSON local (dev) ===== */

let cachedDb = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  cachedDb = client.db('painel_cobrancas');
  return cachedDb;
}

async function loadData() {
  if (process.env.MONGODB_URI) {
    const db = await getDb();
    const doc = await db.collection('appdata').findOne({ _id: 'main' });
    if (doc) { const { _id, ...rest } = doc; return rest; }
    return { payments: [], uploads: [] };
  }
  const file = path.join(__dirname, 'data', 'payments.json');
  if (!fs.existsSync(file)) return { payments: [], uploads: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function saveData(data) {
  if (process.env.MONGODB_URI) {
    const db = await getDb();
    await db.collection('appdata').replaceOne(
      { _id: 'main' },
      { _id: 'main', ...data },
      { upsert: true }
    );
    return;
  }
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'payments.json'), JSON.stringify(data, null, 2));
}

/* ===== MULTER ===== */
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(xlsx|xls)$/i)) cb(null, true);
    else cb(new Error('Apenas arquivos Excel (.xlsx, .xls) são aceitos'));
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ===== HELPERS ===== */
function parseFloat2(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  return parseFloat(String(val).replace(',', '.')) || 0;
}

function parseDate(str) {
  if (!str) return null;
  const [d, m, y] = str.split('/');
  if (!d || !m || !y) return null;
  return new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
}


function parseExcel(buffer, fileName) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const payments = [];

  // Detect header row: find the row that contains the NN column header
  // to handle files that start with metadata rows before the real header
  let startRow = 1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cell = String(rows[i][1] || '').toLowerCase();
    if (cell.includes('nn') || cell.includes('nosso') || cell.includes('número')) {
      startRow = i + 1;
      break;
    }
  }

  for (let i = startRow; i < rows.length; i++) {
    const r = rows[i];
    // Skip empty rows or section-header rows (which have no valid nossoNumero)
    if (!r[0]) continue;
    const nn = String(r[1] || '').trim();
    if (!nn) continue;
    const ocorrencia = String(r[3] || '').trim();
    // Skip rows that don't carry a recognized payment ocorrência
    if (!ocorrencia.match(/0[269]/)) continue;

    // dataVencimento: column 19 is the canonical due date.
    // For "02 - Entrada confirmada" entries the bank sometimes omits it;
    // fall back to dataDebito (r[7]) then to dataOcorrencia (r[4]).
    const rawVenc = String(r[19] || '').trim();
    const rawDeb  = String(r[7]  || '').trim();
    const rawOcor = String(r[4]  || '').trim();
    const dataVencimento = rawVenc || rawDeb || rawOcor;

    payments.push({
      id: `${nn}_${ocorrencia}`,
      pagador: String(r[0] || ''),
      nossoNumero: nn,
      conta: String(r[2] || ''),
      ocorrencia,
      dataOcorrencia: rawOcor,
      tarifa: parseFloat2(r[5]),
      despesa: parseFloat2(r[6]),
      dataDebito: rawDeb,
      dataCredito: String(r[10] || ''),
      valorBoleto: parseFloat2(r[12]),
      numeroBoleto: String(r[14] || ''),
      dataVencimento,
      metodoPagamento: 'boleto',
      observacao: '',
      fileName,
      uploadedAt: new Date().toISOString()
    });
  }
  return payments;
}

function statusPriority(ocorrencia) {
  if (ocorrencia.includes('06')) return 3;
  if (ocorrencia.includes('09')) return 2;
  return 1;
}

/* WhatsApp roda apenas no agente local (whatsapp-local.mjs) */

/* ===== ROTAS ===== */

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const incoming = parseExcel(req.file.buffer, req.file.originalname);
    const data = await loadData();

    const companyMap = {};
    (data.companies || []).forEach(c => { companyMap[c.cnpj] = c; });
    for (const p of incoming) {
      const cnpj = p.pagador.split(' - ')[0]?.trim();
      const registeredCompany = companyMap[cnpj];
      if (registeredCompany) {
        p.metodoPagamento = registeredCompany.metodoPadrao || 'boleto';
      }
    }

    const byNumero = {};
    data.payments.forEach((p, i) => { byNumero[p.nossoNumero] = i; });

    let added = 0, updated = 0, skipped = 0;
    // Track 02 entries that were later elevated to 06 in the SAME file
    const pendentes02 = new Set(incoming.filter(p => p.ocorrencia.includes('02')).map(p => p.nossoNumero));
    const liquidados06 = new Set(incoming.filter(p => p.ocorrencia.includes('06')).map(p => p.nossoNumero));
    // Boletos that appear as 02 AND 06 in the same file = paid in this period
    const elevadosNoPeriodo = [...pendentes02].filter(nn => liquidados06.has(nn)).length;

    for (const p of incoming) {
      const existingIdx = byNumero[p.nossoNumero];
      if (existingIdx === undefined) {
        byNumero[p.nossoNumero] = data.payments.length;
        data.payments.push(p);
        added++;
      } else {
        const existing = data.payments[existingIdx];
        if (statusPriority(p.ocorrencia) > statusPriority(existing.ocorrencia)) {
          data.payments[existingIdx] = {
            ...existing,
            ocorrencia: p.ocorrencia, id: p.id,
            dataOcorrencia: p.dataOcorrencia, dataCredito: p.dataCredito,
            dataDebito: p.dataDebito, valorBoleto: p.valorBoleto,
          };
          updated++;
        } else {
          skipped++;
        }
      }
    }

    // Count truly pending (02) entries now in the database with no vencimento
    const semVencimento = data.payments.filter(p => p.ocorrencia.includes('02') && !p.dataVencimento).length;

    data.uploads.unshift({
      id: Date.now(), fileName: req.file.originalname,
      uploadedAt: new Date().toISOString(),
      rowsAdded: added, rowsUpdated: updated, rowsSkipped: skipped, totalRows: incoming.length
    });
    await saveData(data);
    res.json({
      success: true, added, updated, skipped, total: data.payments.length,
      pendentes: pendentes02.size, elevadosNoPeriodo, semVencimento
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload/preview', upload.single('file'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const preview = rows.slice(0, 8).map((row, ri) => ({
      row: ri,
      cols: row.map((val, ci) => ({ ci, val: String(val ?? '') }))
    }));
    res.json({ totalRows: rows.length, preview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const data = await loadData();
    const payments = data.payments;

    if (payments.length === 0) {
      return res.json({
        totalClientes: 0, boletosMes: 0, totalAReceber: 0,
        totalRecebido: 0, totalVencido: 0, countAReceber: 0,
        countRecebido: 0, countVencido: 0,
        byOcorrencia: {}, uploads: []
      });
    }

    const cnpjs = new Set(payments.map(p => p.pagador.split(' - ')[0]?.trim()));
    const now = new Date();
    const mes = now.getMonth(), ano = now.getFullYear();

    const boletosMes = payments.filter(p => {
      const d = parseDate(p.dataOcorrencia);
      return d && d.getMonth() === mes && d.getFullYear() === ano;
    }).length;

    const recebidos = payments.filter(p => p.ocorrencia.includes('06'));
    const aReceber  = payments.filter(p => p.ocorrencia.includes('02'));
    const vencidos  = payments.filter(p => p.ocorrencia.includes('09'));

    const byOcorrencia = {};
    for (const p of payments) {
      if (!byOcorrencia[p.ocorrencia]) byOcorrencia[p.ocorrencia] = { count: 0, total: 0 };
      byOcorrencia[p.ocorrencia].count++;
      byOcorrencia[p.ocorrencia].total += p.valorBoleto;
    }

    res.json({
      totalClientes: cnpjs.size, boletosMes,
      totalAReceber: aReceber.reduce((s, p) => s + p.valorBoleto, 0),
      totalRecebido: recebidos.reduce((s, p) => s + p.valorBoleto, 0),
      totalVencido:  vencidos.reduce((s, p) => s + p.valorBoleto, 0),
      countAReceber: aReceber.length, countRecebido: recebidos.length, countVencido: vencidos.length,
      byOcorrencia, uploads: data.uploads.slice(0, 10)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/company', async (req, res) => {
  try {
    const cnpj = req.query.cnpj;
    if (!cnpj) return res.status(400).json({ error: 'cnpj obrigatório' });

    const data = await loadData();
    const payments = data.payments.filter(p => p.pagador.startsWith(cnpj));
    if (payments.length === 0) return res.json({ payments: [], monthly: [], cnpj, pagador: cnpj });

    const nomeCompleto = payments[0].pagador;
    const totalLiquidado = payments.filter(p => p.ocorrencia.includes('06')).reduce((s, p) => s + p.valorBoleto, 0);
    const totalBaixa     = payments.filter(p => p.ocorrencia.includes('09')).reduce((s, p) => s + p.valorBoleto, 0);
    const totalAReceber  = payments.filter(p => p.ocorrencia.includes('02')).reduce((s, p) => s + p.valorBoleto, 0);
    const totalGeral     = payments.reduce((s, p) => s + p.valorBoleto, 0);

    const MONTHS_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const monthMap = {};
    for (const p of payments) {
      const d = parseDate(p.dataVencimento) || parseDate(p.dataOcorrencia);
      if (!d) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (!monthMap[key]) monthMap[key] = { key, label: `${MONTHS_PT[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`, liquidado: 0, baixa: 0, areceber: 0 };
      if (p.ocorrencia.includes('06')) monthMap[key].liquidado += p.valorBoleto;
      else if (p.ocorrencia.includes('09')) monthMap[key].baixa += p.valorBoleto;
      else if (p.ocorrencia.includes('02')) monthMap[key].areceber += p.valorBoleto;
    }

    const sorted = [...payments].sort((a, b) => (parseDate(b.dataOcorrencia) || 0) - (parseDate(a.dataOcorrencia) || 0));

    res.json({
      cnpj, pagador: nomeCompleto,
      totalLiquidado, totalBaixa, totalAReceber,
      totalBoletos: payments.length,
      ticketMedio: totalGeral / payments.length,
      monthly: Object.values(monthMap).sort((a, b) => a.key.localeCompare(b.key)),
      payments: sorted
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/payments', async (req, res) => {
  try {
    const data = await loadData();
    const { page = 1, limit = 50, search = '', ocorrencia = '', dataInicio, dataFim } = req.query;
    let filtered = data.payments;
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(p => p.pagador.toLowerCase().includes(s) || p.nossoNumero.includes(s));
    }
    if (ocorrencia) filtered = filtered.filter(p => p.ocorrencia === ocorrencia);
    if (dataInicio) {
      const di = new Date(dataInicio);
      filtered = filtered.filter(p => { const d = parseDate(p.dataVencimento); return d && d >= di; });
    }
    if (dataFim) {
      const df = new Date(dataFim + 'T23:59:59');
      filtered = filtered.filter(p => { const d = parseDate(p.dataVencimento); return d && d <= df; });
    }

    filtered.sort((a, b) => (parseDate(b.dataOcorrencia) || 0) - (parseDate(a.dataOcorrencia) || 0));

    const total = filtered.length;
    const start = (parseInt(page) - 1) * parseInt(limit);
    res.json({ payments: filtered.slice(start, start + parseInt(limit)), total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/payments', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id obrigatório' });
    const data = await loadData();
    const idx = data.payments.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Registro não encontrado' });

    const old = data.payments[idx];
    const updated = {
      ...old,
      pagador: req.body.pagador ?? old.pagador,
      valorBoleto: req.body.valorBoleto !== undefined ? parseFloat(req.body.valorBoleto) : old.valorBoleto,
      dataVencimento: req.body.dataVencimento ?? old.dataVencimento,
      dataOcorrencia: req.body.dataOcorrencia ?? old.dataOcorrencia,
      ocorrencia: req.body.ocorrencia ?? old.ocorrencia,
      telefone: req.body.telefone !== undefined ? req.body.telefone : (old.telefone || ''),
      observacao: req.body.observacao ?? old.observacao,
      metodoPagamento: req.body.metodoPagamento ?? old.metodoPagamento ?? 'boleto',
    };
    updated.id = `${updated.nossoNumero}_${updated.ocorrencia}`;
    data.payments[idx] = updated;
    await saveData(data);
    res.json({ success: true, payment: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payments/baixa', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id obrigatório' });
    const data = await loadData();
    const idx = data.payments.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Registro não encontrado' });

    const p = data.payments[idx];
    const newOcorrencia = '09 - Baixa';
    const newId = `${p.nossoNumero}_${newOcorrencia}`;
    if (data.payments.some((x, i) => i !== idx && x.id === newId))
      return res.status(409).json({ error: 'Baixa já registrada para este boleto' });

    data.payments[idx] = { ...p, ocorrencia: newOcorrencia, id: newId, dataOcorrencia: new Date().toLocaleDateString('pt-BR') };
    await saveData(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/payments', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id obrigatório' });
    const data = await loadData();
    const before = data.payments.length;
    data.payments = data.payments.filter(p => p.id !== id);
    if (data.payments.length === before) return res.status(404).json({ error: 'Registro não encontrado' });
    await saveData(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const data = await loadData();
    const payments = data.payments;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = `${String(today.getDate()).padStart(2,'0')}/${String(today.getMonth()+1).padStart(2,'0')}/${today.getFullYear()}`;

    const pendentes = payments.filter(p => p.ocorrencia.includes('02'));

    const vencendoHoje = pendentes
      .filter(p => p.dataVencimento === todayStr)
      .map(p => ({ id: p.id, pagador: p.pagador, nossoNumero: p.nossoNumero, valorBoleto: p.valorBoleto, dataVencimento: p.dataVencimento }));

    const emAtrasoList = pendentes.filter(p => { const d = parseDate(p.dataVencimento); return d && d < today; });
    const atrasoByCompany = {};
    for (const p of emAtrasoList) {
      const cnpj = p.pagador.split(' - ')[0]?.trim();
      const nome = p.pagador.split(' - ').slice(1).join(' - ') || cnpj;
      if (!atrasoByCompany[cnpj]) atrasoByCompany[cnpj] = { cnpj, nome, count: 0, total: 0 };
      atrasoByCompany[cnpj].count++;
      atrasoByCompany[cnpj].total += p.valorBoleto;
    }

    res.json({
      vencendoHoje,
      emAtraso: Object.values(atrasoByCompany).sort((a, b) => b.total - a.total),
      totalAtrasoValor: emAtrasoList.reduce((s, p) => s + p.valorBoleto, 0),
      date: todayStr
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai-analysis', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key não fornecida' });

  try {
    const data = await loadData();
    const payments = data.payments;
    if (payments.length === 0) return res.status(400).json({ error: 'Nenhum dado para analisar' });

    const totalGeral     = payments.reduce((s, p) => s + p.valorBoleto, 0);
    const totalLiquidado = payments.filter(p => p.ocorrencia.includes('06')).reduce((s, p) => s + p.valorBoleto, 0);
    const totalBaixa     = payments.filter(p => p.ocorrencia.includes('09')).reduce((s, p) => s + p.valorBoleto, 0);
    const multBaixas     = payments.filter(p => p.ocorrencia.includes('09'));
    const baixasMultiplas = Object.entries(
      multBaixas.reduce((acc, p) => { acc[p.pagador] = (acc[p.pagador] || 0) + 1; return acc; }, {})
    ).filter(([, v]) => v > 1);

    const prompt = `Você é um analista financeiro especializado. Analise os dados de cobrança bancária abaixo e forneça um relatório executivo em português com insights relevantes.

DADOS GERAIS:
- Total de registros: ${payments.length}
- Valor total geral: R$ ${totalGeral.toFixed(2)}
- Total liquidado (pago): R$ ${totalLiquidado.toFixed(2)} (${payments.filter(p => p.ocorrencia.includes('06')).length} registros)
- Total baixas (sem pagamento): R$ ${totalBaixa.toFixed(2)} (${payments.filter(p => p.ocorrencia.includes('09')).length} registros)
- Taxa de inadimplência: ${((totalBaixa / (totalLiquidado + totalBaixa)) * 100).toFixed(1)}%

EMPRESAS COM MÚLTIPLAS BAIXAS:
${baixasMultiplas.length > 0 ? baixasMultiplas.map(([n, c]) => `- ${n}: ${c} baixas`).join('\n') : 'Nenhuma'}

Forneça: 1) Resumo Executivo (2-3 linhas) 2) Pontos de Atenção (lista com emojis) 3) Recomendações (3-5 ações) 4) Projeção. Seja direto e objetivo.`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 1000, temperature: 0.3 })
    });
    if (!response.ok) throw new Error(`DeepSeek error: ${response.status}`);
    const result = await response.json();
    res.json({ analysis: result.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ===== Companies CRUD ===== */
app.get('/api/companies', async (req, res) => {
  try {
    const data = await loadData();
    res.json({ companies: data.companies || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/companies', async (req, res) => {
  try {
    const data = await loadData();
    if (!data.companies) data.companies = [];
    const company = {
      id: Date.now().toString(),
      cnpj: (req.body.cnpj || '').trim(),
      nome: (req.body.nome || '').trim(),
      telefone: (req.body.telefone || '').trim(),
      email: (req.body.email || '').trim(),
      metodoPadrao: req.body.metodoPadrao || 'boleto',
      observacao: (req.body.observacao || '').trim(),
      criadoEm: new Date().toISOString()
    };
    if (!company.cnpj || !company.nome) return res.status(400).json({ error: 'CNPJ e nome são obrigatórios' });
    data.companies.push(company);
    await saveData(data);
    res.json({ success: true, company });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/companies', async (req, res) => {
  try {
    const id = req.query.id;
    const data = await loadData();
    const idx = (data.companies || []).findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Empresa não encontrada' });
    data.companies[idx] = { ...data.companies[idx], ...req.body, id };
    await saveData(data);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/companies', async (req, res) => {
  try {
    const id = req.query.id;
    const data = await loadData();
    const before = (data.companies || []).length;
    data.companies = (data.companies || []).filter(c => c.id !== id);
    if (data.companies.length === before) return res.status(404).json({ error: 'Empresa não encontrada' });
    await saveData(data);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ===== Cobranças routes ===== */

app.get('/api/cobrancas/log', async (req, res) => {
  try {
    const data = await loadData();
    res.json({ log: (data.cobrancasLog || []).slice(0, 100) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clear', async (req, res) => {
  try {
    await saveData({ payments: [], uploads: [] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`\n✅ Dashboard rodando em http://localhost:${PORT}\n`));

  console.log('WhatsApp: use o agente local (whatsapp-local.mjs) para envio de cobranças.');
}

module.exports = app;
