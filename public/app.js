/* ===== STATE ===== */
let currentPage = 1;
const PAGE_SIZE = 50;
let chartOcorrencia, chartCompany;
let filterSearch = '', filterOcorrencia = '';
let filterDataInicio = '', filterDataFim = '';
let pendingDeleteId = null;

/* ===== INIT ===== */
document.addEventListener('DOMContentLoaded', () => {
  setHeaderDate();
  initCharts();
  loadDashboard();
  loadPayments();
  loadAlerts();
  scheduleAlertRefresh();
});

function setHeaderDate() {
  document.getElementById('headerDate').textContent = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  });
}

/* ===== CHART INIT ===== */
function initCharts() {
  Chart.defaults.font.family = 'Inter';

  chartOcorrencia = new Chart(document.getElementById('chartOcorrencia'), {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 2, borderColor: '#ffffff', hoverOffset: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#64748b', font: { family: 'Inter', size: 12 }, boxWidth: 12, padding: 16 }
        },
        tooltip: {
          backgroundColor: '#ffffff',
          borderColor: 'rgba(0,0,0,0.1)', borderWidth: 1,
          titleColor: '#1e293b', bodyColor: '#64748b',
          padding: 12, cornerRadius: 8,
          callbacks: {
            label: ctx => ` R$ ${ctx.parsed.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} — ${ctx.label}`
          }
        }
      }
    }
  });
}

/* ===== LOAD DASHBOARD ===== */
async function loadDashboard() {
  try {
    const data = await apiFetch('/api/stats');
    updateKPIs(data);
    updateChart(data);
    updateUploads(data.uploads);
  } catch (e) {
    console.error('Erro ao carregar stats:', e);
  }
}

function fmt(v) {
  return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNum(v) {
  return v.toLocaleString('pt-BR');
}

function updateKPIs(data) {
  animateValue('val-clientes', data.totalClientes, fmtNum);
  animateValue('val-mes', data.boletosMes, fmtNum);
  animateValue('val-areceber', data.totalAReceber, fmt);
  animateValue('val-recebido', data.totalRecebido, fmt);
  animateValue('val-vencido', data.totalVencido, fmt);

  document.getElementById('cnt-areceber').textContent = `${data.countAReceber} pendente${data.countAReceber !== 1 ? 's' : ''}`;
  document.getElementById('cnt-recebido').textContent = `${data.countRecebido} liquidado${data.countRecebido !== 1 ? 's' : ''}`;
  document.getElementById('cnt-vencido').textContent  = `${data.countVencido} não recebido${data.countVencido !== 1 ? 's' : ''}`;
}

function animateValue(id, target, formatter) {
  const el = document.getElementById(id);
  if (!el) return;
  const duration = 900;
  const startTime = performance.now();
  function step(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3);
    el.textContent = formatter(target * ease);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = formatter(target);
  }
  requestAnimationFrame(step);
}

function updateChart(data) {
  const ocColors = {
    '06 - Liquidação sem Float': '#059669',
    '09 - Baixa': '#dc2626',
    '02 - Entrada confirmada': '#b45309'
  };
  const ocLabels = {
    '06 - Liquidação sem Float': 'Liquidado',
    '09 - Baixa': 'Baixa',
    '02 - Entrada confirmada': 'A Receber'
  };

  const entries = Object.entries(data.byOcorrencia || {}).filter(([, v]) => v.total > 0);
  chartOcorrencia.data.labels = entries.map(([k]) => ocLabels[k] || k);
  chartOcorrencia.data.datasets[0].data = entries.map(([, v]) => v.total);
  chartOcorrencia.data.datasets[0].backgroundColor = entries.map(([k]) => ocColors[k] || '#6b7280');
  chartOcorrencia.update('active');

  const total = entries.reduce((s, [, v]) => s + v.count, 0);
  document.getElementById('chart1-period').textContent = `${total} registros`;
}

function updateUploads(uploads) {
  const el = document.getElementById('uploadsHistory');
  if (!uploads || uploads.length === 0) {
    el.innerHTML = '<p class="empty-state">Nenhuma importação ainda</p>';
    return;
  }
  el.innerHTML = uploads.map(u => {
    const date = new Date(u.uploadedAt).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    return `
      <div class="upload-item">
        <div class="upload-dot"></div>
        <div class="upload-info">
          <div class="upload-name">${u.fileName}</div>
          <div class="upload-meta">${date} · ${u.totalRows} linhas</div>
          <div class="upload-stats">
            <span class="upload-stat upload-stat-added">+${u.rowsAdded} novos</span>
            ${(u.rowsUpdated > 0) ? `<span class="upload-stat upload-stat-updated">↑${u.rowsUpdated} atualizados</span>` : ''}
            ${u.rowsSkipped > 0 ? `<span class="upload-stat upload-stat-skipped">${u.rowsSkipped} ignorados</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

/* ===== TABLE ===== */
async function loadPayments() {
  try {
    const params = new URLSearchParams({
      page: currentPage, limit: PAGE_SIZE,
      search: filterSearch, ocorrencia: filterOcorrencia,
      dataInicio: filterDataInicio, dataFim: filterDataFim
    });
    const data = await apiFetch(`/api/payments?${params}`);
    renderTable(data.payments);
    renderPagination(data.total, data.pages);
  } catch (e) {
    document.getElementById('paymentsBody').innerHTML = '<tr><td colspan="6" class="empty-state">Erro ao carregar dados</td></tr>';
  }
}

function renderTable(payments) {
  const tbody = document.getElementById('paymentsBody');
  if (!payments || payments.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhum registro encontrado</td></tr>';
    return;
  }

  tbody.innerHTML = payments.map(p => {
    const parts = p.pagador.split(' - ');
    const cnpj = parts[0] || '';
    const nome = parts.slice(1).join(' - ') || p.pagador;
    const nomeShort = nome.length > 34 ? nome.substring(0, 34) + '…' : nome;

    let pillClass = 'pill-liquidado', pillLabel = 'Liquidado';
    if (p.ocorrencia.includes('09')) { pillClass = 'pill-baixa'; pillLabel = 'Baixa'; }
    else if (p.ocorrencia.includes('02')) { pillClass = 'pill-entrada'; pillLabel = 'A Receber'; }

    let valorClass = 'valor-green';
    if (p.ocorrencia.includes('09')) valorClass = 'valor-red';
    else if (p.ocorrencia.includes('02')) valorClass = 'valor-amber';

    const valor = p.valorBoleto.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const idSafe = encodeURIComponent(p.id);
    const metodoBadge = `<div><span class="method-badge ${(p.metodoPagamento || 'boleto') === 'pix' ? 'method-pix' : 'method-boleto'}">${(p.metodoPagamento || 'boleto') === 'pix' ? '⚡ PIX' : '🏦 Boleto'}</span></div>`;

    // Show "Dar Baixa" only if not already baixa
    const baixaBtn = !p.ocorrencia.includes('09')
      ? `<button class="action-btn action-baixa" onclick="promptBaixa('${idSafe}')" title="Dar Baixa">
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
           <span>Baixa</span>
         </button>`
      : `<span class="action-badge action-baixa-done" title="Já baixado">Baixado</span>`;

    const rowClass = p.ocorrencia.includes('09') ? 'row-baixa' : '';
    return `<tr class="${rowClass}">
      <td>
        <div class="empresa-cell clickable" title="${nome}" onclick="openDrawer('${cnpj.replace(/'/g,"\\'")}', '${nomeShort.replace(/'/g,"\\'")}', '${nome.replace(/'/g,"\\'")}' )">${nomeShort}</div>
        <div class="empresa-cnpj">${cnpj}</div>
      </td>
      <td><span class="status-pill ${pillClass}">${pillLabel}</span>${metodoBadge}</td>
      <td class="valor-cell ${valorClass}">R$ ${valor}</td>
      <td class="date-cell">${p.dataOcorrencia || '—'}</td>
      <td class="date-cell">${p.dataVencimento || '—'}</td>
      <td>
        <div class="action-group">
          ${baixaBtn}
          <button class="action-btn action-edit" onclick="openEditModal('${idSafe}')" title="Editar">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            <span>Editar</span>
          </button>
          <button class="action-btn action-delete" onclick="openDeleteModal('${idSafe}', '${nomeShort.replace(/'/g, "\\'")}', '${valor}')" title="Excluir">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderPagination(total, pages) {
  const el = document.getElementById('pagination');
  if (total === 0) { el.innerHTML = ''; return; }
  const from = (currentPage - 1) * PAGE_SIZE + 1;
  const to = Math.min(currentPage * PAGE_SIZE, total);

  let btns = '';
  const maxBtns = 5;
  let startPage = Math.max(1, currentPage - 2);
  let endPage = Math.min(pages, startPage + maxBtns - 1);
  if (endPage - startPage < maxBtns - 1) startPage = Math.max(1, endPage - maxBtns + 1);
  if (startPage > 1) btns += `<button class="page-btn" onclick="goPage(1)">1</button>`;
  if (startPage > 2) btns += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
  for (let i = startPage; i <= endPage; i++) {
    btns += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goPage(${i})">${i}</button>`;
  }
  if (endPage < pages - 1) btns += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
  if (endPage < pages) btns += `<button class="page-btn" onclick="goPage(${pages})">${pages}</button>`;

  el.innerHTML = `
    <span>Mostrando ${from}–${to} de ${total}</span>
    <div class="pagination-btns">
      <button class="page-btn" onclick="goPage(${currentPage-1})" ${currentPage<=1?'disabled':''}>‹</button>
      ${btns}
      <button class="page-btn" onclick="goPage(${currentPage+1})" ${currentPage>=pages?'disabled':''}>›</button>
    </div>`;
}

function goPage(p) { currentPage = p; loadPayments(); }
function filterPayments() {
  filterSearch = document.getElementById('searchInput').value;
  filterOcorrencia = document.getElementById('filterOcorrencia').value;
  filterDataInicio = document.getElementById('filterDataInicio').value;
  filterDataFim = document.getElementById('filterDataFim').value;
  currentPage = 1; loadPayments();
}

function clearPeriod() {
  document.getElementById('filterDataInicio').value = '';
  document.getElementById('filterDataFim').value = '';
  filterDataInicio = ''; filterDataFim = '';
  currentPage = 1; loadPayments();
}

/* ===== DAR BAIXA ===== */
async function promptBaixa(idEncoded) {
  const id = decodeURIComponent(idEncoded);
  if (!confirm('Confirmar baixa para este boleto?')) return;
  try {
    await apiFetch(`/api/payments/baixa?id=${encodeURIComponent(id)}`, { method: 'POST' });
    showToast('Baixa registrada com sucesso', 'success');
    loadDashboard();
    loadPayments();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ===== EDIT MODAL ===== */
let editPaymentCache = {};

async function openEditModal(idEncoded) {
  const id = decodeURIComponent(idEncoded);
  // Fetch from current payments list (cached in DOM) — just pull from last loaded data
  // Or do a quick lookup via the list endpoint
  try {
    const params = new URLSearchParams({ page: 1, limit: 1000, search: '', ocorrencia: '' });
    const data = await apiFetch(`/api/payments?${params}`);
    const p = data.payments.find(x => x.id === id);
    if (!p) { showToast('Registro não encontrado', 'error'); return; }

    editPaymentCache = p;
    document.getElementById('editId').value = p.id;
    document.getElementById('editPagador').value = p.pagador;
    document.getElementById('editValor').value = p.valorBoleto;
    document.getElementById('editOcorrencia').value = p.ocorrencia;
    document.getElementById('editDataOcorrencia').value = p.dataOcorrencia;
    document.getElementById('editDataVencimento').value = p.dataVencimento;
    document.getElementById('editTelefone').value = p.telefone || '';
    document.getElementById('editObservacao').value = p.observacao || '';
    document.getElementById('editMetodoPagamento').value = p.metodoPagamento || 'boleto';
    document.getElementById('editModal').classList.add('open');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function closeEditModal(e) { if (e.target === document.getElementById('editModal')) closeEditModalDirect(); }
function closeEditModalDirect() { document.getElementById('editModal').classList.remove('open'); }

async function saveEdit() {
  const id = document.getElementById('editId').value;
  const body = {
    pagador: document.getElementById('editPagador').value,
    valorBoleto: parseFloat(document.getElementById('editValor').value),
    ocorrencia: document.getElementById('editOcorrencia').value,
    dataOcorrencia: document.getElementById('editDataOcorrencia').value,
    dataVencimento: document.getElementById('editDataVencimento').value,
    telefone: document.getElementById('editTelefone').value.trim(),
    observacao: document.getElementById('editObservacao').value,
    metodoPagamento: document.getElementById('editMetodoPagamento').value,
  };
  try {
    await apiFetch(`/api/payments?id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    showToast('Registro atualizado com sucesso', 'success');
    closeEditModalDirect();
    loadDashboard();
    loadPayments();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ===== DELETE MODAL ===== */
function openDeleteModal(idEncoded, nome, valor) {
  pendingDeleteId = decodeURIComponent(idEncoded);
  document.getElementById('deleteInfo').textContent = `${nome} — R$ ${valor}`;
  document.getElementById('deleteModal').classList.add('open');
}
function closeDeleteModal(e) { if (e.target === document.getElementById('deleteModal')) closeDeleteModalDirect(); }
function closeDeleteModalDirect() { document.getElementById('deleteModal').classList.remove('open'); pendingDeleteId = null; }

async function confirmDelete() {
  if (!pendingDeleteId) return;
  try {
    await apiFetch(`/api/payments?id=${encodeURIComponent(pendingDeleteId)}`, { method: 'DELETE' });
    showToast('Registro excluído', 'info');
    closeDeleteModalDirect();
    loadDashboard();
    loadPayments();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ===== COMPANY DRAWER ===== */
function openDrawer(cnpj, nomeShort, nomeCompleto) {
  const drawer = document.getElementById('companyDrawer');
  const overlay = document.getElementById('companyDrawerOverlay');
  const loading = document.getElementById('drawerLoading');

  // Set header
  document.getElementById('drawerName').textContent = nomeShort;
  document.getElementById('drawerCnpj').textContent = cnpj;
  document.getElementById('drawerIcon').textContent = (nomeShort[0] || '?').toUpperCase();

  // Reset
  document.getElementById('dk-recebido').textContent = '—';
  document.getElementById('dk-baixa').textContent = '—';
  document.getElementById('dk-areceber').textContent = '—';
  document.getElementById('dk-boletos').textContent = '—';
  document.getElementById('drawerPayments').innerHTML = '';
  loading.classList.remove('hidden');

  drawer.classList.add('open');
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  loadCompanyData(cnpj);
}

async function loadCompanyData(cnpj) {
  const loading = document.getElementById('drawerLoading');
  try {
    const data = await apiFetch(`/api/company?cnpj=${encodeURIComponent(cnpj)}`);
    loading.classList.add('hidden');
    renderDrawerKPIs(data);
    renderDrawerChart(data.monthly);
    renderDrawerPayments(data.payments);
  } catch (err) {
    loading.classList.add('hidden');
    document.getElementById('drawerPayments').innerHTML = `<p class="empty-state">Erro: ${err.message}</p>`;
  }
}

function renderDrawerKPIs(data) {
  const fmtR = v => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('dk-recebido').textContent = fmtR(data.totalLiquidado);
  document.getElementById('dk-baixa').textContent = fmtR(data.totalBaixa);
  document.getElementById('dk-areceber').textContent = fmtR(data.totalAReceber);
  document.getElementById('dk-boletos').textContent = data.totalBoletos;
}

function renderDrawerChart(monthly) {
  if (chartCompany) { chartCompany.destroy(); chartCompany = null; }

  const canvas = document.getElementById('chartCompany');
  if (!monthly || monthly.length === 0) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  chartCompany = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: monthly.map(m => m.label),
      datasets: [
        {
          label: 'Recebido',
          data: monthly.map(m => m.liquidado),
          backgroundColor: 'rgba(5,150,105,0.7)',
          borderColor: '#059669',
          borderWidth: 1,
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'Baixa',
          data: monthly.map(m => m.baixa),
          backgroundColor: 'rgba(220,38,38,0.65)',
          borderColor: '#dc2626',
          borderWidth: 1,
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'A Receber',
          data: monthly.map(m => m.areceber),
          backgroundColor: 'rgba(180,83,9,0.65)',
          borderColor: '#b45309',
          borderWidth: 1,
          borderRadius: 4,
          borderSkipped: false,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#64748b', font: { family: 'Inter', size: 11 }, boxWidth: 10, padding: 12 }
        },
        tooltip: {
          backgroundColor: '#ffffff',
          borderColor: 'rgba(0,0,0,0.1)', borderWidth: 1,
          titleColor: '#1e293b', bodyColor: '#64748b',
          padding: 10, cornerRadius: 8,
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: R$ ${ctx.parsed.y.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
          }
        }
      },
      scales: {
        x: {
          stacked: false,
          ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 0 },
          grid: { display: false },
          border: { color: 'rgba(0,0,0,0.1)' }
        },
        y: {
          ticks: {
            color: '#64748b', font: { size: 10 },
            callback: v => 'R$ ' + Number(v).toLocaleString('pt-BR', { notation: 'compact' })
          },
          grid: { color: 'rgba(0,0,0,0.06)' },
          border: { color: 'rgba(0,0,0,0.1)' }
        }
      }
    }
  });
}

function renderDrawerPayments(payments) {
  const el = document.getElementById('drawerPayments');
  if (!payments || payments.length === 0) {
    el.innerHTML = '<p class="empty-state">Sem registros</p>';
    return;
  }

  const ocLabel = { '06 - Liquidação sem Float': ['Recebido', 'valor-green'], '09 - Baixa': ['Baixa', 'valor-red'], '02 - Entrada confirmada': ['A Receber', 'valor-amber'] };

  el.innerHTML = payments.map(p => {
    const [label, cls] = ocLabel[p.ocorrencia] || ['—', ''];
    const valor = p.valorBoleto.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const pillClass = p.ocorrencia.includes('06') ? 'pill-liquidado' : p.ocorrencia.includes('09') ? 'pill-baixa' : 'pill-entrada';
    return `
      <div class="drawer-payment-item">
        <div class="dpi-left">
          <span class="dpi-boleto">Boleto #${p.numeroBoleto || p.nossoNumero.split('/')[1] || '—'}</span>
          <span class="dpi-date">Venc: ${p.dataVencimento || '—'} · Ocorr: ${p.dataOcorrencia || '—'}</span>
          ${p.observacao ? `<span class="dpi-date" style="color:var(--cyan)">💬 ${p.observacao}</span>` : ''}
        </div>
        <div class="dpi-right">
          <span class="dpi-valor ${cls}">R$ ${valor}</span>
          <span class="status-pill ${pillClass}">${label}</span>
        </div>
      </div>`;
  }).join('');
}

function closeDrawer(e) {
  if (e.target === document.getElementById('companyDrawerOverlay')) closeDrawerDirect();
}
function closeDrawerDirect() {
  document.getElementById('companyDrawer').classList.remove('open');
  document.getElementById('companyDrawerOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

/* ===== UPLOAD MODAL ===== */
function openUploadModal() { document.getElementById('uploadModal').classList.add('open'); resetUploadModal(); }
function closeUploadModal(e) { if (e.target === document.getElementById('uploadModal')) closeUploadModalDirect(); }
function closeUploadModalDirect() { document.getElementById('uploadModal').classList.remove('open'); }
function resetUploadModal() {
  document.getElementById('uploadProgress').classList.add('hidden');
  document.getElementById('uploadResult').classList.add('hidden');
  document.getElementById('dropZone').classList.remove('hidden');
  document.getElementById('progressFill').style.width = '0%';
}
function onDragOver(e) { e.preventDefault(); document.getElementById('dropZone').classList.add('drag-over'); }
function onDragLeave() { document.getElementById('dropZone').classList.remove('drag-over'); }
function onDrop(e) { e.preventDefault(); document.getElementById('dropZone').classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f) uploadFile(f); }
function handleFileSelect(e) { const f = e.target.files[0]; if (f) uploadFile(f); }

async function uploadFile(file) {
  if (!file.name.match(/\.(xlsx|xls)$/i)) { showToast('Apenas .xlsx ou .xls', 'error'); return; }
  const dropZone = document.getElementById('dropZone');
  const progress = document.getElementById('uploadProgress');
  const resultEl = document.getElementById('uploadResult');
  dropZone.classList.add('hidden');
  progress.classList.remove('hidden');
  resultEl.classList.add('hidden');

  const fill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  let pct = 0;
  const ticker = setInterval(() => { pct = Math.min(pct + Math.random() * 15, 85); fill.style.width = pct + '%'; }, 200);
  progressText.textContent = `Processando ${file.name}…`;

  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json();
    clearInterval(ticker); fill.style.width = '100%';
    if (data.success) {
      progressText.textContent = 'Concluído!';
      setTimeout(() => {
        progress.classList.add('hidden');
        resultEl.className = 'upload-result result-success';
        const elevMsg = data.elevadosNoPeriodo > 0
        ? `<br><span style="font-size:13px;color:#0284c7">ℹ️ ${data.elevadosNoPeriodo} boleto(s) apareceram como pendente (02) e pago (06) no mesmo arquivo — salvos como <strong>Liquidado</strong></span>`
        : '';
      const semVencMsg = data.semVencimento > 0
        ? `<br><span style="font-size:13px;color:#b45309">⚠️ ${data.semVencimento} boleto(s) "A Receber" sem data de vencimento — não aparecerão nos alertas de atraso</span>`
        : '';
      resultEl.innerHTML = `✅ <strong>${data.added} registros novos</strong>
          ${data.updated > 0 ? `<br><span style="font-size:13px;opacity:.8">↑ ${data.updated} boletos atualizados (status superior)</span>` : ''}
          ${data.skipped > 0 ? `<br><span style="font-size:13px;opacity:.8">${data.skipped} ignorados (sem alteração)</span>` : ''}
          ${elevMsg}${semVencMsg}
          <br><span style="font-size:13px;opacity:.8">Total no banco: ${data.total} registros</span>`;
        resultEl.classList.remove('hidden');
        loadDashboard(); loadPayments(); loadAlerts();
        const toastMsg = [data.added > 0 ? `${data.added} novos` : '', data.updated > 0 ? `${data.updated} atualizados` : ''].filter(Boolean).join(', ');
        showToast(toastMsg || 'Arquivo processado', 'success');
      }, 600);
    } else throw new Error(data.error || 'Erro desconhecido');
  } catch (err) {
    clearInterval(ticker);
    progress.classList.add('hidden');
    resultEl.className = 'upload-result result-error';
    resultEl.textContent = `❌ Erro: ${err.message}`;
    resultEl.classList.remove('hidden');
    showToast(err.message, 'error');
  }
  document.getElementById('fileInput').value = '';
}

/* ===== AI MODAL ===== */
function openAiModal() { document.getElementById('aiModal').classList.add('open'); }
function closeAiModal(e) { if (e.target === document.getElementById('aiModal')) closeAiModalDirect(); }
function closeAiModalDirect() { document.getElementById('aiModal').classList.remove('open'); }

async function runAiAnalysis() {
  const apiKey = document.getElementById('deepseekKey').value.trim();
  if (!apiKey) { showToast('Informe a chave da API DeepSeek', 'error'); return; }
  const resultEl = document.getElementById('aiResult');
  const loadingEl = document.getElementById('aiLoading');
  resultEl.classList.add('hidden'); loadingEl.classList.remove('hidden');
  try {
    const data = await apiFetch('/api/ai-analysis', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey })
    });
    loadingEl.classList.add('hidden');
    resultEl.textContent = data.analysis;
    resultEl.classList.remove('hidden');
    showToast('Análise concluída!', 'success');
  } catch (err) {
    loadingEl.classList.add('hidden');
    resultEl.className = 'upload-result result-error';
    resultEl.textContent = `❌ Erro: ${err.message}`;
    resultEl.classList.remove('hidden');
    showToast('Erro ao conectar com DeepSeek', 'error');
  }
}

/* ===== HELPERS ===== */
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast toast-${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

/* ===== ALERTS ===== */

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function isDismissed(type) {
  return localStorage.getItem(`alert_dismissed_${getTodayKey()}_${type}`) === '1';
}

function dismissAlert(type) {
  localStorage.setItem(`alert_dismissed_${getTodayKey()}_${type}`, '1');
  const card = document.getElementById(`alert-card-${type}`);
  if (card) {
    card.style.transition = 'opacity .3s, transform .3s';
    card.style.opacity = '0';
    card.style.transform = 'translateX(20px)';
    setTimeout(() => {
      card.remove();
      const container = document.getElementById('alertsContainer');
      if (container && container.querySelectorAll('.alert-card').length === 0) {
        container.innerHTML = '<div class="alert-empty" style="padding:16px 8px;text-align:center;color:var(--text-muted);font-size:12px">Todos os alertas foram fechados.<br>Reaparecerão amanhã.</div>';
      }
    }, 320);
  }
}

async function loadAlerts() {
  const container = document.getElementById('alertsContainer');
  if (!container) return;
  container.innerHTML = '<div class="alert-loading"><div class="ai-spinner" style="width:20px;height:20px;border-width:2px"></div></div>';
  try {
    const data = await apiFetch('/api/alerts');
    renderAlerts(data);
  } catch {
    container.innerHTML = '<div class="alert-empty" style="padding:16px;color:var(--text-muted);font-size:12px">Erro ao carregar alertas.</div>';
  }
}

function renderAlerts(data) {
  const container = document.getElementById('alertsContainer');
  if (!container) return;
  const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const cards = [];

  if (!isDismissed('hoje')) {
    const count = data.vencendoHoje.length;
    const items = count === 0
      ? '<div class="alert-empty"><span class="alert-empty-icon">✅</span>Nenhum boleto vence hoje</div>'
      : `<div class="alert-list">${data.vencendoHoje.slice(0, 5).map(p => {
          const cnpj = p.pagador.split(' - ')[0]?.trim();
          const nome = p.pagador.split(' - ').slice(1).join(' - ') || p.pagador;
          const nomeShort = nome.length > 26 ? nome.substring(0, 26) + '…' : nome;
          const valor = p.valorBoleto.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
          const safeC = (cnpj||'').replace(/'/g,"\\'"), safeS = nomeShort.replace(/'/g,"\\'"), safeN = nome.replace(/'/g,"\\'");
          return `<div class="alert-item alert-item-link" onclick="openDrawer('${safeC}','${safeS}','${safeN}')" title="Ver histórico de ${nomeShort}">
            <div class="alert-item-nome">${nomeShort}</div>
            <div class="alert-item-meta">
              <span>${(p.nossoNumero.split('/')[1] || p.nossoNumero).slice(-8)}</span>
              <span class="alert-item-valor alert-item-valor-amber">${valor}</span>
            </div></div>`;
        }).join('')}
        ${count > 5 ? `<div class="alert-empty" style="padding:4px 0 0;font-size:11px">+${count - 5} outros</div>` : ''}
      </div>`;
    cards.push(`<div class="alert-card alert-card-amber" id="alert-card-hoje">
      <div class="alert-card-head">
        <div class="alert-card-title-row">
          <div class="alert-dot alert-dot-amber"></div>
          <span class="alert-card-title">Vencimentos Hoje</span>
          ${count > 0 ? `<span class="alert-badge alert-badge-amber">${count}</span>` : ''}
        </div>
        <button class="alert-dismiss" onclick="dismissAlert('hoje')" title="Fechar">×</button>
      </div>
      ${items}
      <div class="alert-updated">Atualizado às ${now}</div>
    </div>`);
  }

  if (!isDismissed('atraso')) {
    const count = data.emAtraso.length;
    const totalStr = data.totalAtrasoValor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const items = count === 0
      ? '<div class="alert-empty"><span class="alert-empty-icon">✅</span>Nenhuma empresa em atraso</div>'
      : `<div class="alert-list">${data.emAtraso.slice(0, 5).map(c => {
          const nomeShort = c.nome.length > 26 ? c.nome.substring(0, 26) + '…' : c.nome;
          const valor = c.total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
          const safeC = c.cnpj.replace(/'/g,"\\'"), safeS = nomeShort.replace(/'/g,"\\'"), safeN = c.nome.replace(/'/g,"\\'");
          return `<div class="alert-item alert-item-link" onclick="openDrawer('${safeC}','${safeS}','${safeN}')" title="Ver histórico de ${nomeShort}">
            <div class="alert-item-nome">${nomeShort}</div>
            <div class="alert-item-meta">
              <span>${c.count} boleto${c.count > 1 ? 's' : ''}</span>
              <span class="alert-item-valor alert-item-valor-red">${valor}</span>
            </div></div>`;
        }).join('')}
        ${count > 5 ? `<div class="alert-empty" style="padding:4px 0 0;font-size:11px">+${count - 5} empresas</div>` : ''}
      </div>`;
    cards.push(`<div class="alert-card alert-card-red" id="alert-card-atraso">
      <div class="alert-card-head">
        <div class="alert-card-title-row">
          <div class="alert-dot alert-dot-red"></div>
          <span class="alert-card-title">Em Atraso</span>
          ${count > 0 ? `<span class="alert-badge alert-badge-red">${count}</span>` : ''}
        </div>
        <button class="alert-dismiss" onclick="dismissAlert('atraso')" title="Fechar">×</button>
      </div>
      ${items}
      <div class="alert-updated">${count > 0 ? `Total: ${totalStr} · ` : ''}${now}</div>
    </div>`);
  }

  container.innerHTML = cards.length === 0
    ? '<div class="alert-empty" style="padding:16px 8px;text-align:center;color:var(--text-muted);font-size:12px">Alertas fechados.<br>Reaparecerão amanhã.</div>'
    : cards.join('');
}

function scheduleAlertRefresh() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
  setTimeout(() => { loadAlerts(); scheduleAlertRefresh(); }, midnight - now);
}

/* ===== COMPANIES MODAL ===== */
function openCompaniesModal() {
  document.getElementById('companiesModal').classList.add('open');
  loadCompanies();
}
function closeCompaniesModal(e) { if (e.target === document.getElementById('companiesModal')) closeCompaniesModalDirect(); }
function closeCompaniesModalDirect() {
  document.getElementById('companiesModal').classList.remove('open');
  closeCompanyForm();
}

async function loadCompanies() {
  try {
    const data = await apiFetch('/api/companies');
    renderCompanies(data.companies || []);
  } catch { document.getElementById('companiesList').innerHTML = '<p class="empty-state">Erro ao carregar</p>'; }
}

function renderCompanies(companies) {
  const el = document.getElementById('companiesList');
  document.getElementById('companiesCount').textContent = `${companies.length} empresa${companies.length !== 1 ? 's' : ''}`;
  if (companies.length === 0) { el.innerHTML = '<p class="empty-state">Nenhuma empresa cadastrada</p>'; return; }
  el.innerHTML = companies.map(c => {
    const initial = (c.nome || '?')[0].toUpperCase();
    const badge = c.metodoPadrao === 'pix'
      ? `<span class="method-badge method-pix">⚡ PIX</span>`
      : `<span class="method-badge method-boleto">🏦 Boleto</span>`;
    return `<div class="company-card">
      <div class="company-card-icon">${initial}</div>
      <div class="company-card-info">
        <div class="company-card-nome">${c.nome}</div>
        <div class="company-card-cnpj">${c.cnpj} ${badge}</div>
      </div>
      <div class="company-card-actions">
        <button class="company-action-btn" onclick="openCompanyForm('${c.id}')" title="Editar">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="company-action-btn del" onclick="deleteCompany('${c.id}', '${c.nome.replace(/'/g,"\\'")}' )" title="Excluir">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

let companiesCache = [];
async function openCompanyForm(id) {
  const col = document.getElementById('companyFormCol');
  const title = document.getElementById('companyFormTitle');
  document.querySelector('.companies-layout').classList.add('form-open');
  col.style.display = 'flex';
  col.style.flexDirection = 'column';
  col.style.gap = '16px';

  if (id) {
    try {
      const data = await apiFetch('/api/companies');
      const c = (data.companies || []).find(x => x.id === id);
      if (!c) return;
      title.textContent = 'Editar Empresa';
      document.getElementById('companyFormId').value = c.id;
      document.getElementById('compCnpj').value = c.cnpj;
      document.getElementById('compNome').value = c.nome;
      document.getElementById('compTelefone').value = c.telefone || '';
      document.getElementById('compEmail').value = c.email || '';
      document.getElementById('compMetodo').value = c.metodoPadrao || 'boleto';
      document.getElementById('compObservacao').value = c.observacao || '';
    } catch { showToast('Erro ao carregar empresa', 'error'); }
  } else {
    title.textContent = 'Nova Empresa';
    document.getElementById('companyFormId').value = '';
    document.getElementById('compCnpj').value = '';
    document.getElementById('compNome').value = '';
    document.getElementById('compTelefone').value = '';
    document.getElementById('compEmail').value = '';
    document.getElementById('compMetodo').value = 'boleto';
    document.getElementById('compObservacao').value = '';
  }
}

function closeCompanyForm() {
  document.getElementById('companyFormCol').style.display = 'none';
  document.querySelector('.companies-layout').classList.remove('form-open');
}

async function saveCompany() {
  const id = document.getElementById('companyFormId').value;
  const body = {
    cnpj: document.getElementById('compCnpj').value.trim(),
    nome: document.getElementById('compNome').value.trim(),
    telefone: document.getElementById('compTelefone').value.trim(),
    email: document.getElementById('compEmail').value.trim(),
    metodoPadrao: document.getElementById('compMetodo').value,
    observacao: document.getElementById('compObservacao').value.trim()
  };
  if (!body.cnpj || !body.nome) { showToast('CNPJ e nome são obrigatórios', 'error'); return; }
  try {
    if (id) {
      await apiFetch(`/api/companies?id=${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      showToast('Empresa atualizada', 'success');
    } else {
      await apiFetch('/api/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      showToast('Empresa cadastrada', 'success');
    }
    closeCompanyForm();
    loadCompanies();
  } catch (err) { showToast(err.message, 'error'); }
}

async function deleteCompany(id, nome) {
  if (!confirm(`Excluir "${nome}"?`)) return;
  try {
    await apiFetch(`/api/companies?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast('Empresa removida', 'success');
    loadCompanies();
  } catch (err) { showToast(err.message, 'error'); }
}

/* ===== WHATSAPP ===== */

const WPP_AGENT = 'http://localhost:3001';

let wppPolling = null;

async function wppFetch(path, opts = {}) {
  const res = await fetch(`${WPP_AGENT}${path}`, { ...opts, headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function openWppModal() {
  document.getElementById('wppModal').classList.add('open');
  wppCheckStatus();
  loadWppLog();
  wppPolling = setInterval(wppCheckStatus, 3000);
}

function closeWppModal(e) {
  if (e.target === document.getElementById('wppModal')) closeWppModalDirect();
}

function closeWppModalDirect() {
  document.getElementById('wppModal').classList.remove('open');
  clearInterval(wppPolling);
  wppPolling = null;
}

async function wppCheckStatus() {
  try {
    const data = await wppFetch('/status');
    applyWppStatus(data.status);
    if (data.status === 'qr') {
      const qrData = await wppFetch('/qr').catch(() => null);
      if (qrData?.qr) {
        document.getElementById('wppQrImg').src = qrData.qr;
        document.getElementById('wppQrImg').style.display = 'block';
        document.getElementById('wppQrSpinner').style.display = 'none';
      }
    }
    updateHeaderWppDot(data.status);
  } catch {
    applyWppStatus('agent_offline');
    updateHeaderWppDot('disconnected');
  }
}

function applyWppStatus(status) {
  const dot          = document.getElementById('wppStatusDot');
  const label        = document.getElementById('wppStatusLabel');
  const sub          = document.getElementById('wppStatusSub');
  const connectBtn   = document.getElementById('wppConnectBtn');
  const disconnectBtn= document.getElementById('wppDisconnectBtn');
  const qrSection    = document.getElementById('wppQrSection');
  const chargeSection= document.getElementById('wppChargeSection');

  dot.className = 'wpp-status-dot-lg';
  qrSection.style.display = 'none';
  chargeSection.style.display = 'none';
  connectBtn.style.display = 'none';
  disconnectBtn.style.display = 'none';

  if (status === 'ready') {
    dot.classList.add('wpp-dot-green');
    label.textContent = 'Conectado';
    sub.textContent = 'WhatsApp vinculado e pronto para enviar cobranças';
    disconnectBtn.style.display = '';
    chargeSection.style.display = '';
  } else if (status === 'qr') {
    dot.classList.add('wpp-dot-amber');
    label.textContent = 'Aguardando QR Code';
    sub.textContent = 'Escaneie o código abaixo com o WhatsApp do celular';
    qrSection.style.display = '';
    document.getElementById('wppQrImg').style.display = 'none';
    document.getElementById('wppQrSpinner').style.display = '';
    disconnectBtn.style.display = '';
  } else if (status === 'connecting') {
    dot.classList.add('wpp-dot-amber');
    label.textContent = 'Conectando…';
    sub.textContent = 'Iniciando sessão WhatsApp';
    disconnectBtn.style.display = '';
  } else if (status === 'error') {
    dot.classList.add('wpp-dot-red');
    label.textContent = 'Erro ao conectar';
    sub.textContent = 'Reinicie o agente local: npm run wpp';
    connectBtn.style.display = '';
  } else if (status === 'agent_offline') {
    dot.classList.add('wpp-dot-gray');
    label.textContent = 'Agente offline';
    sub.textContent = 'Dê duplo clique em whatsapp-iniciar.bat no seu computador';
    connectBtn.style.display = 'none';
  } else {
    dot.classList.add('wpp-dot-gray');
    label.textContent = 'Desconectado';
    sub.textContent = 'Clique em Conectar para vincular o WhatsApp';
    connectBtn.style.display = '';
  }
}

function updateHeaderWppDot(status) {
  const dot = document.getElementById('wppDot');
  if (!dot) return;
  dot.className = 'wpp-dot';
  if (status === 'ready')      dot.classList.add('wpp-dot-green');
  else if (status === 'qr' || status === 'connecting') dot.classList.add('wpp-dot-amber');
  else dot.classList.add('wpp-dot-gray');
}

async function wppConnect() {
  try {
    await wppFetch('/connect', { method: 'POST' });
    wppCheckStatus();
  } catch { showToast('Agente local offline. Execute: npm run wpp', 'error'); }
}

async function wppDisconnect() {
  if (!confirm('Desconectar o WhatsApp?')) return;
  try {
    await wppFetch('/disconnect', { method: 'POST' });
    applyWppStatus('disconnected');
    updateHeaderWppDot('disconnected');
    showToast('WhatsApp desconectado', 'info');
  } catch (err) { showToast(err.message, 'error'); }
}

async function wppEnviar(tipo) {
  const labels = { aviso: 'avisos (vencimento amanhã)', vencimento: 'cobranças do dia', atraso: 'cobranças em atraso' };
  if (!confirm(`Enviar ${labels[tipo]} agora?`)) return;
  try {
    showToast('Enviando mensagens…', 'info');
    const r = await wppFetch(`/enviar?tipo=${tipo}`, { method: 'POST' });
    let msg = `${r.enviados} enviada(s), ${r.erros} erro(s), ${r.pulados} pulado(s)`;
    if (r.skipReasons?.semTelefone > 0) msg += ` — ${r.skipReasons.semTelefone} sem telefone cadastrado`;
    showToast(msg, r.enviados > 0 ? 'success' : 'info');
    loadWppLog();
  } catch { showToast('Agente local offline. Execute: npm run wpp', 'error'); }
}

async function loadWppLog() {
  const el = document.getElementById('wppLog');
  if (!el) return;
  try {
    const data = await wppFetch('/log').catch(() => ({ log: [] }));
    const log = data.log || [];
    if (log.length === 0) {
      el.innerHTML = '<p class="empty-state" style="padding:16px">Nenhum envio registrado</p>';
      return;
    }
    const tipoLabel = { aviso: 'Aviso', vencimento: 'Vencimento', atraso: 'Atraso' };
    const tipoCls   = { aviso: 'wpp-log-aviso', vencimento: 'wpp-log-venc', atraso: 'wpp-log-atraso' };
    el.innerHTML = log.map(l => {
      const dt = new Date(l.sentAt).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
      const valor = (l.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      return `<div class="wpp-log-item">
        <span class="wpp-log-badge ${tipoCls[l.tipo] || ''}">${tipoLabel[l.tipo] || l.tipo}</span>
        <div class="wpp-log-info">
          <div class="wpp-log-nome">${l.nome}</div>
          <div class="wpp-log-meta">${l.telefone} · ${valor} · venc. ${l.vencimento || '—'}</div>
        </div>
        <div class="wpp-log-dt">${dt}</div>
      </div>`;
    }).join('');
  } catch {
    el.innerHTML = '<p class="empty-state" style="padding:16px">Erro ao carregar log</p>';
  }
}

// Carrega status do WhatsApp no header ao iniciar
document.addEventListener('DOMContentLoaded', () => {
  apiFetch('/api/whatsapp/status').then(d => updateHeaderWppDot(d.status)).catch(() => {});
});
