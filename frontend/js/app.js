document.addEventListener('DOMContentLoaded', () => {
    let ws = null;
    let currentPlan = null;
    let activeProfiles = [];
    let availableProviders = [];
    let taskScore = parseInt(localStorage.getItem('taskScore')) || 0;

    // DOM Elements
    const wsStatusIndicator = document.getElementById('ws-status-indicator');
    const wsStatusText = document.getElementById('ws-status-text');

    const toggleSkipPerms = document.getElementById('toggle-skip-permissions');
    const toggleRtk = document.getElementById('toggle-rtk');
    const toggleCaveman = document.getElementById('toggle-caveman');
    const toggleAutoRotate = document.getElementById('toggle-auto-rotate');
    const toggleCliProviders = document.getElementById('toggle-cli-providers');

    const btnIncWorkers = document.getElementById('btn-inc-workers');
    const btnDecWorkers = document.getElementById('btn-dec-workers');
    const workersCountVal = document.getElementById('workers-count-val');

    const promptInput = document.getElementById('prompt-input');
    const btnSendPrompt = document.getElementById('btn-send-prompt');
    const chatMessages = document.getElementById('chat-messages');

    const planContainer = document.getElementById('plan-container');
    const planTitle = document.getElementById('plan-title');
    const planTaskCount = document.getElementById('plan-task-count');
    const planSummary = document.getElementById('plan-summary');
    const planTaskList = document.getElementById('plan-task-list');
    const btnExecutePlan = document.getElementById('btn-execute-plan');

    const workersGrid = document.getElementById('workers-grid');
    const terminalBody = document.getElementById('terminal-body');
    const btnClearLogs = document.getElementById('btn-clear-logs');
    const chkAutoScroll = document.getElementById('chk-auto-scroll');

    const btnManageProfiles = document.getElementById('btn-manage-profiles');
    const profilesModal = document.getElementById('profiles-modal');
    const btnCloseModal = document.getElementById('btn-close-modal');
    const profilesList = document.getElementById('profiles-list');
    const newProfileName = document.getElementById('new-profile-name');
    const btnAddProfile = document.getElementById('btn-add-profile');
    const currentProfileName = document.getElementById('current-profile-name');

    const btnManageProviders = document.getElementById('btn-manage-providers');
    const providersModal = document.getElementById('providers-modal');
    const btnCloseProvidersModal = document.getElementById('btn-close-providers-modal');
    const providersList = document.getElementById('providers-list');
    const btnAddProvider = document.getElementById('btn-add-provider');

    // WebSocket Connection
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            wsStatusIndicator.className = 'status-indicator online';
            wsStatusText.textContent = 'Conectado';
            appendLog('[SINGULARITY] Conectado ao servidor principal.', 'info');
        };

        ws.onclose = () => {
            wsStatusIndicator.className = 'status-indicator offline';
            wsStatusText.textContent = 'Desconectado';
            appendLog('[SINGULARITY] Conexão perdida. Reconectando...', 'warning');
            setTimeout(connectWebSocket, 3000);
        };

        ws.onerror = (err) => console.error('WebSocket Error:', err);

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleServerMessage(data);
        };
    }

    function handleServerMessage(data) {
        switch (data.type) {
            case 'init_state':
                syncSettings(data.state.settings);
                renderWorkers(data.workers || []);
                if (data.providers) {
                    availableProviders = data.providers;
                    renderProvidersList(data.providers);
                }
                if (data.chat_history && data.chat_history.length > 0) {
                    chatMessages.innerHTML = '';
                    data.chat_history.forEach(msg => appendChatMessage(msg.sender, msg.text));
                }
                if (data.plan && data.plan.tasks) {
                    currentPlan = data.plan;
                    renderPlan(data.plan);
                }
                fetchProfiles();
                fetchProviders();
                break;

            case 'settings_updated':
                syncSettings(data.settings);
                break;

            case 'state_cleared':
                // Outra aba/cliente limpou tudo — reflete aqui também.
                chatMessages.innerHTML = '<div class="chat-bubble system-bubble"><div class="bubble-title">🪐 Singularity Multi-Agent Ready</div><p>Sistema reiniciado. Pronto para nova missão.</p></div>';
                planContainer.classList.add('hidden');
                currentPlan = null;
                break;

            case 'chat_message':
                appendChatMessage(data.sender, data.text);
                break;

            case 'orchestrator_status':
                appendChatMessage('orchestrator', data.text);
                break;

            case 'plan_ready':
                currentPlan = data.plan;
                renderPlan(data.plan);
                showPlanReadyAlert();
                break;

            case 'terminal_log':
                appendLog(`[${data.worker_id}] ${data.text}`, data.log_type);
                break;

            case 'task_update':
                updateTaskStatusInPlan(data.task_id, data.status);
                break;

            case 'worker_status_update':
                updateSingleWorkerCard(data.worker);
                break;

            case 'worker_task_done':
                recordWorkerTask(data);
                break;

            case 'workers_list_update':
                renderWorkers(data.workers);
                break;

            case 'validation_complete':
                showValidationReport(data.report);
                if (data.telemetry) {
                    loadAndOpenTelemetryModal(data.telemetry);
                }
                break;
        }
    }

    let currentSettings = {};

    function syncSettings(settings) {
        if (!settings) return;
        currentSettings = settings;
        toggleSkipPerms.checked = settings.skip_permissions;
        toggleRtk.checked = settings.use_rtk;
        toggleCaveman.checked = settings.use_caveman;
        toggleAutoRotate.checked = settings.auto_rotate_quota;
        if (toggleCliProviders) toggleCliProviders.checked = settings.use_cli_providers;
        workersCountVal.textContent = settings.max_workers;
        const workDirInput = document.getElementById('work-dir-input');
        if (workDirInput && settings.active_work_dir) {
            workDirInput.value = settings.active_work_dir;
        }
    }

    function sendSettingUpdate(key, value) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'update_setting',
                key: key,
                value: value
            }));
        }
        localStorage.setItem(`setting_${key}`, value);
    }

    // Load initial from localStorage
    ['skip_permissions', 'use_rtk', 'use_caveman', 'auto_rotate_quota', 'use_cli_providers'].forEach(key => {
        const val = localStorage.getItem(`setting_${key}`);
        if (val !== null) {
            const isChecked = val === 'true';
            if (key === 'skip_permissions') toggleSkipPerms.checked = isChecked;
            if (key === 'use_rtk') toggleRtk.checked = isChecked;
            if (key === 'use_caveman') toggleCaveman.checked = isChecked;
            if (key === 'auto_rotate_quota') toggleAutoRotate.checked = isChecked;
            if (key === 'use_cli_providers' && toggleCliProviders) toggleCliProviders.checked = isChecked;
        }
    });
    const savedWorkers = localStorage.getItem('setting_max_workers');
    if (savedWorkers) workersCountVal.textContent = savedWorkers;

    // Toggle Listeners
    toggleSkipPerms.addEventListener('change', (e) => sendSettingUpdate('skip_permissions', e.target.checked));
    toggleRtk.addEventListener('change', (e) => sendSettingUpdate('use_rtk', e.target.checked));
    toggleCaveman.addEventListener('change', (e) => sendSettingUpdate('use_caveman', e.target.checked));
    toggleAutoRotate.addEventListener('change', (e) => sendSettingUpdate('auto_rotate_quota', e.target.checked));
    if (toggleCliProviders) toggleCliProviders.addEventListener('change', (e) => sendSettingUpdate('use_cli_providers', e.target.checked));

    btnIncWorkers.addEventListener('click', () => {
        let current = parseInt(workersCountVal.textContent) || 2;
        if (current < 10) sendSettingUpdate('max_workers', current + 1);
    });

    btnDecWorkers.addEventListener('click', () => {
        let current = parseInt(workersCountVal.textContent) || 2;
        if (current > 1) sendSettingUpdate('max_workers', current - 1);
    });

    // Chat Prompt
    btnSendPrompt.addEventListener('click', sendPrompt);
    const btnAsk = document.getElementById('btn-ask');
    if (btnAsk) btnAsk.addEventListener('click', sendAsk);
    promptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendPrompt();
        }
        // Shift+Enter = quebra de linha (textarea maior). Ctrl+Enter = Perguntar (chat).
        if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            sendAsk();
        }
    });

    let conversationActive = false;  // true após usar 💬 Perguntar (permite Gerar Plano da conversa)

    function currentSkill() {
        const sel = document.getElementById('skill-select');
        return sel ? sel.value : 'auto';
    }
    function currentTargetDir() {
        const workDirInput = document.getElementById('work-dir-input');
        return workDirInput ? workDirInput.value.trim() : 'D:\\APP android teste';
    }

    function sendPrompt() {
        const prompt = promptInput.value.trim();
        // Caixa vazia sem conversa → avisa em vez de ficar mudo/parado.
        if (!prompt && !conversationActive) {
            appendChatMessage('orchestrator', '⚠️ Digite o objetivo na caixa, ou use 💬 Perguntar para refinar antes de Gerar Plano.');
            return;
        }
        if (prompt) appendChatMessage('user', prompt);
        promptInput.value = '';
        // Feedback imediato (não fica sem resposta enquanto a Camada 1/2 pensa)
        appendChatMessage('orchestrator', prompt ? '🚀 Gerando plano...' : '🚀 Gerando plano a partir da conversa...');

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'user_prompt',
                prompt: prompt,
                work_dir: currentTargetDir(),
                skill_id: currentSkill()
            }));
        }
    }

    // Chat conversacional (Q&A grátis) — não executa plano, só conversa/refina.
    function sendAsk() {
        const message = promptInput.value.trim();
        if (!message) return;
        conversationActive = true;
        appendChatMessage('user', message);
        promptInput.value = '';
        showTyping();
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'chat_query',
                message: message,
                work_dir: currentTargetDir(),
                skill_id: currentSkill()
            }));
        }
    }

    // Popula o seletor de skills (presets por tipo de projeto)
    async function loadSkills() {
        const sel = document.getElementById('skill-select');
        if (!sel) return;
        try {
            const res = await fetch('/api/skills');
            const data = await res.json();
            sel.innerHTML = '';
            (data.skills || []).forEach(s => {
                const o = document.createElement('option');
                o.value = s.id;
                o.textContent = `${s.icon} ${s.name}`;
                o.title = s.description;
                sel.appendChild(o);
            });
            const saved = localStorage.getItem('setting_skill_id');
            if (saved) sel.value = saved;
            sel.addEventListener('change', () => localStorage.setItem('setting_skill_id', sel.value));
        } catch (e) { console.error('Erro ao carregar skills:', e); }
    }
    loadSkills();

    function showTyping() {
        removeTyping();
        const div = document.createElement('div');
        div.id = 'chat-typing';
        div.className = 'chat-bubble system-bubble typing-bubble';
        div.innerHTML = `
            <div class="bubble-title">🧠 Claude Orquestrador</div>
            <div class="typing-dots"><span></span><span></span><span></span></div>
        `;
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    function removeTyping() {
        const t = document.getElementById('chat-typing');
        if (t) t.remove();
    }

    function appendChatMessage(sender, text) {
        // Chegou mensagem do orquestrador → some o "digitando..."
        if (sender !== 'user') removeTyping();
        const div = document.createElement('div');
        div.className = `chat-bubble ${sender === 'user' ? 'user-bubble' : 'system-bubble'}`;
        
        const title = document.createElement('div');
        title.className = 'bubble-title';
        title.textContent = sender === 'user' ? '👤 Você' : '🧠 Claude Orquestrador';
        
        const p = document.createElement('p');
        p.textContent = text;
        
        div.appendChild(title);
        div.appendChild(p);
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function renderPlan(plan) {
        planContainer.classList.remove('hidden');
        planTitle.textContent = plan.project_title || 'Plano do Projeto';
        planSummary.textContent = plan.summary || '';
        
        const tasks = plan.tasks || [];
        planTaskCount.textContent = `${tasks.length} Tarefas`;
        planTaskList.innerHTML = '';

        tasks.forEach(t => {
            const item = document.createElement('div');
            item.className = 'task-item';
            item.id = `task-item-${t.id}`;
            item.innerHTML = `
                <div>
                    <strong>#${t.id} ${t.title}</strong>
                    <div style="font-size: 10px; color: #9ca3af;">Provedor: ${t.provider || 'antigravity'} | Complexidade: ${t.complexity}</div>
                </div>
                <span class="badge badge-amber" id="task-status-${t.id}">Pendente</span>
            `;
            planTaskList.appendChild(item);
        });
    }

    function showPlanReadyAlert() {
        // Alerta inline acima do botão
        const alert = document.getElementById('execute-ready-alert');
        if (alert) {
            alert.classList.remove('hidden');
        }
        // Toast flutuante no canto
        const toast = document.getElementById('toast-ready');
        if (toast) {
            toast.classList.remove('hidden');
            // Auto-fechar após 8 segundos
            setTimeout(() => toast.classList.add('hidden'), 8000);
        }
        // Pulsar o botão
        if (btnExecutePlan) {
            btnExecutePlan.style.animation = 'none';
            btnExecutePlan.style.boxShadow = '0 0 20px rgba(139,92,246,0.8), 0 0 40px rgba(139,92,246,0.4)';
            setTimeout(() => { btnExecutePlan.style.boxShadow = ''; }, 8000);
        }
    }

    btnExecutePlan.addEventListener('click', () => {
        if (!currentPlan) return;
        // Fechar alertas ao iniciar
        const alert = document.getElementById('execute-ready-alert');
        if (alert) alert.classList.add('hidden');
        const toast = document.getElementById('toast-ready');
        if (toast) toast.classList.add('hidden');
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'start_execution',
                prompt: currentPlan.summary || 'Executar plano'
            }));
        }
    });

    function updateTaskStatusInPlan(taskId, status) {
        const badge = document.getElementById(`task-status-${taskId}`);
        if (badge) {
            if (status === 'completed') {
                badge.className = 'badge badge-green';
                badge.textContent = 'Concluído';
                taskScore++;
                localStorage.setItem('taskScore', taskScore);
            } else if (status === 'in_progress') {
                badge.className = 'badge badge-purple';
                badge.textContent = 'Executando';
            } else if (status === 'failed') {
                badge.className = 'badge badge-amber';
                badge.textContent = 'Falhou';
            }
        }
    }

    let currentWorkersState = [];
    // Histórico de tarefas por worker: { 'Worker-1': [{title, status, seconds}], ... }
    const workerHistory = {};

    function recordWorkerTask(d) {
        if (!d || !d.worker_id) return;
        if (!workerHistory[d.worker_id]) workerHistory[d.worker_id] = [];
        workerHistory[d.worker_id].push({
            title: d.title || `Tarefa #${d.task_id}`,
            status: d.status,
            seconds: d.seconds
        });
        renderWorkers(currentWorkersState);
    }

    function updateSingleWorkerCard(worker) {
        const idx = currentWorkersState.findIndex(w => w.id === worker.id);
        if (idx !== -1) {
            currentWorkersState[idx] = worker;
        } else {
            currentWorkersState.push(worker);
        }
        renderWorkers(currentWorkersState);
    }

    function renderWorkers(workers) {
        if (!workers) return;
        currentWorkersState = workers;
        workersGrid.innerHTML = '';
        if (workers.length === 0) {
            workersGrid.innerHTML = '<div style="color: #6b7280; font-size: 12px;">Nenhum operário ativo no momento.</div>';
            return;
        }

        workers.forEach(w => {
            const card = document.createElement('div');
            card.className = `worker-card ${w.is_busy ? 'busy' : ''}`;
            // Worker OCIOSO mostra estado limpo (não repete o último job após F5/término).
            const idle = !w.is_busy;
            const provider = idle ? '—' : (w.provider || 'antigravity');
            const profile = idle ? '—' : (w.profile || 'Padrão');
            const model = idle ? '—' : (w.model || 'Padrão');
            const taskText = idle ? 'Aguardando tarefa...' : (w.current_task || w.task || 'Executando...');
            const hist = workerHistory[w.id] || [];
            const histHtml = hist.length ? `
                <div class="worker-history">
                    ${hist.map(h => `
                        <div class="worker-hist-item ${h.status === 'success' ? 'ok' : 'fail'}">
                            <span class="hist-icon">${h.status === 'success' ? '✅' : '❌'}</span>
                            <span class="hist-title" title="${escapeHtml(h.title)}">${escapeHtml(h.title)}</span>
                            <span class="hist-time">${h.seconds != null ? h.seconds + 's' : ''}</span>
                        </div>
                    `).join('')}
                </div>
            ` : '';
            card.innerHTML = `
                <div class="worker-card-header">
                    <span class="worker-card-title">👷 ${w.id}</span>
                    <span class="badge ${w.is_busy ? 'badge-purple' : 'badge-green'}">${w.is_busy ? 'Ocupado' : 'Livre'}</span>
                </div>
                <div class="worker-card-meta">
                    <div>IA CLI: <strong>${provider}</strong></div>
                    <div>Perfil: <strong>${profile}</strong></div>
                    <div>Modelo: <strong>${model}</strong></div>
                </div>
                <div class="worker-task-desc">
                    ${taskText}
                </div>
                ${histHtml}
            `;
            workersGrid.appendChild(card);
        });
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function appendLog(text, logType = 'info') {
        const line = document.createElement('div');
        line.className = `log-line ${logType}`;
        const now = new Date();
        const ts = now.toTimeString().slice(0, 8); // HH:MM:SS
        const timeSpan = document.createElement('span');
        timeSpan.className = 'log-time';
        timeSpan.textContent = ts;
        line.appendChild(timeSpan);
        line.appendChild(document.createTextNode(text));
        terminalBody.appendChild(line);

        if (chkAutoScroll.checked) {
            terminalBody.scrollTop = terminalBody.scrollHeight;
        }
    }

    btnClearLogs.addEventListener('click', () => {
        terminalBody.innerHTML = '<div class="log-line info">[TERMINAL] Logs limpos.</div>';
    });

    // Limpar tudo: terminal + chat + plano
    const btnClearAll = document.getElementById('btn-clear-all');
    if (btnClearAll) {
        btnClearAll.addEventListener('click', async () => {
            if (!confirm('Limpar terminal, chat e plano atual? Isso não afeta os arquivos do projeto.')) return;
            // Limpa o estado NO SERVIDOR (chat + plano em disco) para que o refresh não
            // reidrate tudo de volta via init_state do WebSocket.
            try {
                await fetch('/api/orchestrator/clear', { method: 'POST' });
            } catch (e) {
                console.error('Erro ao limpar estado no servidor:', e);
            }
            terminalBody.innerHTML = '<div class="log-line info">[SINGULARITY] Sistema reiniciado. Aguardando nova missão...</div>';
            chatMessages.innerHTML = '<div class="chat-bubble system-bubble"><div class="bubble-title">🪐 Singularity Multi-Agent Ready</div><p>Sistema reiniciado. Pronto para nova missão.</p></div>';
            planContainer.classList.add('hidden');
            currentPlan = null;
            conversationActive = false;
            removeTyping();
            // limpa o histórico de tarefas dos workers
            Object.keys(workerHistory).forEach(k => delete workerHistory[k]);
            renderWorkers(currentWorkersState);
            // fecha o painel de relatório final se estiver aberto
            const rp = document.getElementById('validation-report-panel');
            if (rp) rp.classList.add('hidden');
            const alert = document.getElementById('execute-ready-alert');
            if (alert) alert.classList.add('hidden');
            const toast = document.getElementById('toast-ready');
            if (toast) toast.classList.add('hidden');
        });
    }

    // Modais
    btnManageProfiles.addEventListener('click', () => {
        profilesModal.classList.remove('hidden');
        fetchProfiles();
    });

    btnCloseModal.addEventListener('click', () => profilesModal.classList.add('hidden'));

    btnManageProviders.addEventListener('click', async () => {
        providersModal.classList.remove('hidden');
        // Carregar as 3 seções do modal: provedores CLI, pool de chaves NVIDIA e catálogo/modelos por camada.
        // (fetchNvidiaKeys vivia num bloco morto de #btn-providers que nunca disparava — bug corrigido.)
        fetchProviders();
        fetchNvidiaKeys();
        checkNvidiaCatalog();
    });

    btnCloseProvidersModal.addEventListener('click', () => providersModal.classList.add('hidden'));

    async function fetchProfiles() {
        try {
            const res = await fetch('/api/profiles');
            const data = await res.json();
            activeProfiles = data.profiles || [];
            renderProfilesList(activeProfiles, data.active_index);
            if (activeProfiles.length > 0) {
                const active = activeProfiles[data.active_index % activeProfiles.length];
                currentProfileName.textContent = active ? active.name : 'perfil_primario';
            }
        } catch (e) { console.error('Erro ao buscar perfis:', e); }
    }

    function renderProfilesList(profiles, activeIndex) {
        profilesList.innerHTML = '';
        profiles.forEach((p, idx) => {
            const div = document.createElement('div');
            div.className = 'profile-item';
            div.innerHTML = `
                <div>
                    <strong>${p.name} ${idx === activeIndex ? '⭐ (Ativo)' : ''}</strong>
                    <div style="font-size: 10px; color: #9ca3af;">${p.path}</div>
                </div>
                <button class="btn btn-sm btn-outline" onclick="deleteProfile('${p.name}')">Excluir</button>
            `;
            profilesList.appendChild(div);
        });
    }

    btnAddProfile.addEventListener('click', async () => {
        const name = newProfileName.value.trim();
        if (!name) return;
        await fetch('/api/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name })
        });
        newProfileName.value = '';
        fetchProfiles();
    });

    window.deleteProfile = async (name) => {
        await fetch(`/api/profiles/${name}`, { method: 'DELETE' });
        fetchProfiles();
    };

    async function fetchProviders() {
        try {
            const res = await fetch('/api/providers');
            const data = await res.json();
            availableProviders = data;
            renderProvidersList(data);
        } catch (e) { console.error('Erro ao buscar provedores:', e); }
    }

    function renderProvidersList(providers) {
        providersList.innerHTML = '';
        providers.forEach(p => {
            const div = document.createElement('div');
            div.className = 'provider-item';
            div.innerHTML = `
                <div>
                    <strong>🤖 ${p.name} (<code>${p.id}</code>)</strong>
                    <div style="font-size: 10px; color: #9ca3af;">Executável: <code>${p.cli_binary}</code> | Modelo Padrão: ${p.default_model}</div>
                </div>
                ${['antigravity', 'claude_code'].includes(p.id) ? '<span class="badge badge-purple">Nativo</span>' : `<button class="btn btn-sm btn-outline" onclick="deleteProvider('${p.id}')">Remover</button>`}
            `;
            providersList.appendChild(div);
        });
    }

    btnAddProvider.addEventListener('click', async () => {
        const id = document.getElementById('new-provider-id').value.trim();
        const name = document.getElementById('new-provider-name').value.trim();
        const binary = document.getElementById('new-provider-binary').value.trim();
        const defaultModel = document.getElementById('new-provider-default-model').value.trim() || 'default';
        const supportedModelsRaw = document.getElementById('new-provider-supported-models').value.trim();
        const template = document.getElementById('new-provider-template').value.trim();

        if (!id || !name || !binary || !template) return;

        const supportedModels = supportedModelsRaw 
            ? supportedModelsRaw.split(',').map(m => m.trim()).filter(m => m.length > 0)
            : [defaultModel];

        await fetch('/api/providers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: id,
                name: name,
                cli_binary: binary,
                command_template: template,
                skip_permissions_flag: "--dangerously-skip-permissions",
                default_model: defaultModel,
                supported_models: supportedModels,
                is_active: true
            })
        });

        document.getElementById('new-provider-id').value = '';
        document.getElementById('new-provider-name').value = '';
        document.getElementById('new-provider-binary').value = '';
        document.getElementById('new-provider-default-model').value = '';
        document.getElementById('new-provider-supported-models').value = '';
        document.getElementById('new-provider-template').value = '';
        fetchProviders();
    });

    window.deleteProvider = async (id) => {
        await fetch(`/api/providers/${id}`, { method: 'DELETE' });
        fetchProviders();
    };

    // ─── NVIDIA Keys Management ──────────────────────────────────────────────
    // Renderização básica (lista mascarada — rápida, local). Enriquecida por status.
    async function fetchNvidiaKeys() {
        try {
            const res = await fetch('/api/nvidia-keys');
            const data = await res.json();
            renderNvidiaKeys(data.keys);
        } catch (e) {
            console.error('Erro ao buscar chaves NVIDIA:', e);
        }
    }

    function renderNvidiaKeys(keys) {
        const container = document.getElementById('nvidia-keys-list');
        if (!container) return;
        if (!keys || keys.length === 0) {
            container.innerHTML = '<p style="font-size: 11px; color: var(--text-dim); font-style: italic;">Nenhuma chave cadastrada. Adicione uma chave nvapi-... para ativar a Camada 2 e o Auto-Healing.</p>';
            return;
        }
        container.innerHTML = keys.map((k, i) => `
            <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(118,185,0,0.08); border: 1px solid rgba(118,185,0,0.25); padding: 6px 10px; border-radius: 5px; font-size: 11px; font-family: monospace;">
                <span style="color: #76b900;">🔑 ${k}</span>
                <button onclick="removeNvidiaKey(${i})" style="background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #f87171; border-radius: 4px; padding: 2px 7px; cursor: pointer; font-size: 10px;">✕</button>
            </div>
        `).join('');
    }

    // Status individual por chave (válida/erro/RPM) via /api/nvidia-keys/status
    async function validateNvidiaKeys() {
        const container = document.getElementById('nvidia-keys-list');
        try {
            const res = await fetch('/api/nvidia-keys/status');
            const data = await res.json();
            if (data.status === 'ok') {
                renderNvidiaKeyStatus(data.keys);
            } else if (data.status === 'no_keys') {
                renderNvidiaKeys([]);
            }
        } catch (e) {
            console.error('Erro ao validar chaves NVIDIA:', e);
        }
    }

    function renderNvidiaKeyStatus(keys) {
        const container = document.getElementById('nvidia-keys-list');
        if (!container) return;
        if (!keys || keys.length === 0) { renderNvidiaKeys([]); return; }
        container.innerHTML = keys.map(k => {
            const ok = k.valid;
            const color = ok ? '#22c55e' : '#ef4444';
            const status = ok
                ? `✅ válida · ${k.rpm_used}/${k.rpm_limit} RPM`
                : `🔴 ${k.error ? k.error.substring(0, 42) : 'erro'}`;
            const border = ok ? 'rgba(118,185,0,0.25)' : 'rgba(239,68,68,0.4)';
            return `
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; background: rgba(118,185,0,0.08); border: 1px solid ${border}; padding: 6px 10px; border-radius: 5px; font-size: 11px; font-family: monospace;">
                <span style="color: #76b900;">🔑 ${k.masked}</span>
                <span style="color: ${color}; font-size: 10px; flex: 1; text-align: right;">${status}</span>
                <button onclick="removeNvidiaKey(${k.index})" style="background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #f87171; border-radius: 4px; padding: 2px 7px; cursor: pointer; font-size: 10px;">✕</button>
            </div>`;
        }).join('');
    }

    window.removeNvidiaKey = async (index) => {
        await fetch(`/api/nvidia-keys/${index}`, { method: 'DELETE' });
        fetchNvidiaKeys();
    };

    const btnAddNvidiaKey = document.getElementById('btn-add-nvidia-key');
    if (btnAddNvidiaKey) {
        btnAddNvidiaKey.addEventListener('click', async () => {
            const keyInput = document.getElementById('new-nvidia-key');
            const key = keyInput.value.trim();
            if (!key || !key.startsWith('nvapi-')) {
                alert('Chave inválida. A chave deve começar com nvapi-');
                return;
            }
            await fetch('/api/nvidia-keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key })
            });
            keyInput.value = '';
            fetchNvidiaKeys();
            checkNvidiaCatalog();
        });
    }

    const btnValidateKeys = document.getElementById('btn-validate-nvidia-keys');
    if (btnValidateKeys) {
        btnValidateKeys.addEventListener('click', validateNvidiaKeys);
    }

    // ─── Catálogo NVIDIA ao vivo + Modelos por Camada ────────────────────────
    const LAYER_KEYS = ['layer1_fallback_model', 'layer2_model', 'layer2_fallback_model', 'layer3_model', 'layer3_fallback_model'];
    let liveCatalog = [];

    // Consulta o catálogo NVIDIA vivo e popula os dropdowns por camada.
    // NUNCA troca modelo sozinho — só reporta divergência num card de alerta.
    async function checkNvidiaCatalog() {
        const countEl = document.getElementById('catalog-count');
        try {
            const res = await fetch('/api/nvidia-catalog/check');
            const data = await res.json();
            if (data.status === 'no_keys') {
                if (countEl) countEl.textContent = 'Sem chaves NVIDIA — adicione uma chave para carregar o catálogo.';
                renderModelDropdowns([], configuredFromSettings(), {});
                return;
            }
            if (data.status === 'error') {
                if (countEl) countEl.textContent = 'Erro ao consultar catálogo: ' + (data.message || '');
                renderModelDropdowns([], configuredFromSettings(), {});
                return;
            }
            liveCatalog = data.catalog || [];
            if (countEl) countEl.textContent = `${data.count} modelos vivos no catálogo NVIDIA.`;
            renderModelDropdowns(liveCatalog, data.configured || configuredFromSettings(), data.missing || {});
            renderCatalogAlert(data.missing || {});
        } catch (e) {
            console.error('Erro ao verificar catálogo NVIDIA:', e);
        }
    }

    function configuredFromSettings() {
        const c = {};
        LAYER_KEYS.forEach(k => { c[k] = currentSettings[k] || ''; });
        return c;
    }

    function renderModelDropdowns(catalog, configured, missing) {
        LAYER_KEYS.forEach(key => {
            const sel = document.getElementById('model-' + key);
            if (!sel) return;
            const current = (configured && configured[key]) || sel.value || '';
            const opts = new Set(catalog);
            if (current) opts.add(current);
            sel.innerHTML = '';
            Array.from(opts).sort().forEach(m => {
                const o = document.createElement('option');
                const inCatalog = catalog.includes(m);
                o.value = m;
                o.textContent = inCatalog ? m : `${m} (fora do catálogo)`;
                if (m === current) o.selected = true;
                sel.appendChild(o);
            });
            // Borda vermelha se o modelo configurado sumiu do catálogo vivo
            sel.style.borderColor = (missing && missing[key]) ? '#ef4444' : '';
            sel.onchange = () => saveLayerModel(key, sel.value);
        });
    }

    function renderCatalogAlert(missing) {
        const box = document.getElementById('catalog-alert');
        if (!box) return;
        const keys = Object.keys(missing || {});
        if (keys.length === 0) { box.classList.add('hidden'); box.innerHTML = ''; return; }
        box.classList.remove('hidden');
        box.innerHTML =
            '<strong>⚠️ Modelo(s) configurado(s) fora do catálogo NVIDIA atual:</strong>' +
            '<ul style="margin: 4px 0 0 16px;">' +
            keys.map(k => `<li>${k}: <code>${missing[k]}</code></li>`).join('') +
            '</ul>' +
            '<div style="margin-top: 6px; font-size: 11px;">Selecione um modelo válido no dropdown correspondente para atualizar. Nenhuma troca é feita automaticamente.</div>';
    }

    // Recalcula o alerta localmente após uma troca manual (sem re-consultar a API).
    function recomputeCatalogAlert() {
        const missing = {};
        LAYER_KEYS.forEach(key => {
            const sel = document.getElementById('model-' + key);
            if (sel && sel.value && liveCatalog.length && !liveCatalog.includes(sel.value)) {
                missing[key] = sel.value;
            }
            if (sel) sel.style.borderColor = missing[key] ? '#ef4444' : '';
        });
        renderCatalogAlert(missing);
    }

    async function saveLayerModel(key, value) {
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: value })
            });
            currentSettings[key] = value;
            appendLog(`[CONFIG] ${key} = ${value}`, 'info');
            recomputeCatalogAlert();
        } catch (e) {
            console.error('Erro ao salvar modelo da camada:', e);
        }
    }

    const btnCheckCatalog = document.getElementById('btn-check-catalog');
    if (btnCheckCatalog) {
        btnCheckCatalog.addEventListener('click', () => { checkNvidiaCatalog(); validateNvidiaKeys(); });
    }

    // Probe de INFERÊNCIA REAL: chat streaming de 1 token em cada modelo configurado.
    // "ON" passa a refletir se o modelo responde de fato (não só chave/catálogo).
    async function probeModels() {
        const note = document.getElementById('model-health-note');
        const btn = document.getElementById('btn-probe-models');
        if (note) note.textContent = '🩺 Testando inferência real dos modelos (pode levar até ~90s p/ modelos reasoning)...';
        if (btn) { btn.disabled = true; }
        try {
            const res = await fetch('/api/nvidia-models/health', { method: 'POST' });
            const data = await res.json();
            if (data.status === 'no_keys') {
                if (note) note.textContent = 'Sem chaves NVIDIA — adicione uma chave para testar.';
                return;
            }
            const map = {};
            (data.models || []).forEach(r => { map[r.model] = r; });
            // Marca cada dropdown com o status real do seu modelo atual
            LAYER_KEYS.forEach(key => {
                const sel = document.getElementById('model-' + key);
                if (!sel) return;
                let span = document.getElementById('health-' + key);
                if (!span) {
                    span = document.createElement('span');
                    span.id = 'health-' + key;
                    span.style.cssText = 'font-size:10px; margin-left:8px; font-weight:600;';
                    if (sel.parentNode) sel.parentNode.appendChild(span);
                }
                const r = map[sel.value];
                if (!r) { span.textContent = ''; return; }
                span.textContent = r.alive ? `✅ responde (${r.latency}s)` : `❌ ${r.error || 'falhou'}`;
                span.style.color = r.alive ? '#34d399' : '#f87171';
                sel.style.borderColor = r.alive ? '#34d399' : '#ef4444';
            });
            const alive = (data.models || []).filter(m => m.alive).length;
            const total = (data.models || []).length;
            if (note) note.textContent = `Inferência real: ${alive}/${total} modelos responderam. ❌ = não serve chat agora (mesmo aparecendo no catálogo).`;
        } catch (e) {
            console.error('Erro no probe de modelos:', e);
            if (note) note.textContent = 'Erro ao testar inferência: ' + e;
        } finally {
            if (btn) { btn.disabled = false; }
        }
    }

    const btnProbeModels = document.getElementById('btn-probe-models');
    if (btnProbeModels) {
        btnProbeModels.addEventListener('click', probeModels);
    }

    // Diagnostics Modal Elements
    const btnOpenDiagnostics = document.getElementById('btn-open-diagnostics');
    const diagnosticsModal = document.getElementById('diagnostics-modal');
    const btnCloseDiagnostics = document.getElementById('btn-close-diagnostics');
    const btnRunHealthCheck = document.getElementById('btn-run-health-check');
    const btnRunAutoFix = document.getElementById('btn-run-auto-fix');
    const diagnosticsTbody = document.getElementById('diagnostics-table-body');
    const diagnosticsLogBox = document.getElementById('diagnostics-log-box');

    if (btnOpenDiagnostics && diagnosticsModal) {
        btnOpenDiagnostics.addEventListener('click', async () => {
            diagnosticsModal.classList.remove('hidden');
            // Garantir que os provedores foram carregados antes de renderizar
            if (availableProviders.length === 0) {
                await fetchProviders();
            }
            renderDiagnosticsTable({});
        });
    }

    if (btnCloseDiagnostics && diagnosticsModal) {
        btnCloseDiagnostics.addEventListener('click', () => diagnosticsModal.classList.add('hidden'));
    }

    function renderDiagnosticsTable(checkResults) {
        if (!diagnosticsTbody) return;
        if (availableProviders.length === 0) {
            diagnosticsTbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">Carregando provedores...</td></tr>';
            return;
        }
        diagnosticsTbody.innerHTML = '';
        availableProviders.forEach(p => {
            const res = checkResults[p.id];
            let statusBadge = '<span class="badge badge-amber" style="font-size:10px;">— Não Testado</span>';
            if (res) {
                if (res.status === 'online') {
                    statusBadge = `<span class="badge badge-green" style="font-size:10px;">🟢 Online (${res.latency}s)</span>`;
                } else if (res.status === 'no_keys') {
                    statusBadge = `<span class="badge badge-amber" style="font-size:10px;">🔑 Sem Chaves (nvapi-...)</span>`;
                } else if (res.status === 'not_logged_in') {
                    statusBadge = `<span class="badge badge-amber" style="font-size:10px;">🔑 Requer Login ('claude login')</span>`;
                } else if (res.status === 'binary_missing') {
                    statusBadge = `<span class="badge" style="background:#2a1a1a;color:#ef4444;font-size:10px;">⛔ Binário não encontrado</span>`;
                } else if (res.status === 'quota_exceeded') {
                    statusBadge = `<span class="badge badge-amber" style="font-size:10px;">🟡 Cota Esgotada</span>`;
                } else if (res.status === 'timeout') {
                    statusBadge = `<span class="badge badge-amber" style="font-size:10px;">⏱️ Timeout</span>`;
                } else {
                    statusBadge = `<span class="badge" style="background:#2a1a1a;color:#ef4444;font-size:10px;">🔴 ${res.message ? res.message.substring(0,40) : 'Erro'}</span>`;
                }
            }

            const models = (p.supported_models || []).map(m => `<span class="badge" style="background:#1a1a2e;font-size:9px;margin:1px;">${m}</span>`).join(' ');
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${p.name}</strong></td>
                <td><code>${p.cli_binary}</code></td>
                <td style="font-size:10px;">${models || p.default_model}</td>
                <td>${statusBadge}</td>
                <td><button class="btn btn-sm btn-outline" style="font-size:10px;padding:2px 8px;" onclick="testSingleProvider('${p.id}')">🔍 Testar</button></td>
            `;
            diagnosticsTbody.appendChild(tr);
        });
    }

    window.testSingleProvider = async (providerId) => {
        if (diagnosticsLogBox) {
            diagnosticsLogBox.classList.remove('hidden');
            diagnosticsLogBox.textContent = `Testando ${providerId}...`;
        }
        try {
            const res = await fetch(`/api/health-check?provider_id=${providerId}`, { method: 'POST' });
            const data = await res.json();
            renderDiagnosticsTable(data);
            if (diagnosticsLogBox) {
                diagnosticsLogBox.textContent = JSON.stringify(data, null, 2);
            }
        } catch (e) {
            console.error('Erro ao testar provedor:', e);
        }
    };

    if (btnRunHealthCheck) {
        btnRunHealthCheck.addEventListener('click', async () => {
            if (diagnosticsLogBox) {
                diagnosticsLogBox.classList.remove('hidden');
                diagnosticsLogBox.textContent = 'Testando todas as IAs em paralelo...';
            }
            try {
                const res = await fetch('/api/health-check', { method: 'POST' });
                const data = await res.json();
                renderDiagnosticsTable(data);
                if (diagnosticsLogBox) {
                    diagnosticsLogBox.textContent = JSON.stringify(data, null, 2);
                }
            } catch (e) {
                console.error('Erro no health-check:', e);
            }
        });
    }

    if (btnRunAutoFix) {
        btnRunAutoFix.addEventListener('click', async () => {
            if (diagnosticsLogBox) {
                diagnosticsLogBox.classList.remove('hidden');
                diagnosticsLogBox.textContent = 'Executando rotina de Auto-Correção...';
            }
            try {
                const res = await fetch('/api/auto-fix', { method: 'POST' });
                const data = await res.json();
                if (diagnosticsLogBox) {
                    diagnosticsLogBox.textContent = "⚡ RESULTADO DA AUTO-CORREÇÃO:\n" + (data.fixes || []).join('\n');
                }
                fetchProviders();
            } catch (e) {
                console.error('Erro ao auto-corrigir:', e);
            }
        });
    }

    // Telemetry Modal Elements
    const btnOpenTelemetry = document.getElementById('btn-open-telemetry');
    const telemetryModal = document.getElementById('telemetry-modal');
    const btnCloseTelemetry = document.getElementById('btn-close-telemetry');

    if (btnOpenTelemetry && telemetryModal) {
        btnOpenTelemetry.addEventListener('click', () => loadAndOpenTelemetryModal());
    }
    if (btnCloseTelemetry && telemetryModal) {
        btnCloseTelemetry.addEventListener('click', () => telemetryModal.classList.add('hidden'));
    }

    async function loadAndOpenTelemetryModal(data) {
        if (!data) {
            try {
                const res = await fetch('/api/orchestrator/telemetry');
                data = await res.json();
            } catch (e) {
                console.error("Erro ao carregar telemetria:", e);
            }
        }

        if (data && data.total_tasks !== undefined) {
            document.getElementById('telemetry-profiles').textContent = (data.profiles_used || []).join(', ') || 'Padrão';
            document.getElementById('telemetry-models').textContent = (data.models_used || []).join(', ') || 'Padrão';
            document.getElementById('telemetry-tokens').textContent = (data.total_tokens_approx || 0).toLocaleString();
            document.getElementById('telemetry-saved').textContent = (data.total_tokens_saved || 0).toLocaleString() + ' ⚡';

            const tbody = document.getElementById('telemetry-table-body');
            if (tbody) {
                tbody.innerHTML = '';
                (data.task_details || []).forEach(t => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><strong>#${t.task_id}</strong></td>
                        <td>${t.title}</td>
                        <td><span class="badge badge-purple">${t.worker_id}</span></td>
                        <td><code>${t.profile_name}</code></td>
                        <td>${t.model}</td>
                        <td>${t.use_caveman ? '🦴 Caveman' : ''} ${t.use_rtk ? '🛠️ RTK' : ''}</td>
                        <td>${t.approx_tokens.toLocaleString()}</td>
                        <td>${t.seconds != null ? t.seconds + 's' : '-'}</td>
                        <td><span class="badge ${t.status === 'success' ? 'badge-green' : 'badge-amber'}">${t.status}</span></td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        }

        // Carregar preview do relatório markdown
        try {
            const reportRes = await fetch('/api/orchestrator/report-file');
            if (reportRes.ok) {
                const mdText = await reportRes.text();
                const preview = document.getElementById('report-markdown-preview');
                if (preview) preview.textContent = mdText;
            }
        } catch (e) {
            console.error("Erro ao carregar texto do relatório:", e);
        }

        if (telemetryModal) {
            telemetryModal.classList.remove('hidden');
        }
    }

    function showValidationReport(report) {
        const panel = document.getElementById('validation-report-panel');
        const content = document.getElementById('report-content-markdown');
        if (panel && content) {
            panel.classList.remove('hidden');
            content.innerText = report;
        }
    }

    // Fechar (X) o painel do Parecer Final — não tinha listener, por isso não fechava.
    const btnCloseReport = document.getElementById('btn-close-report');
    if (btnCloseReport) {
        btnCloseReport.addEventListener('click', () => {
            const panel = document.getElementById('validation-report-panel');
            if (panel) panel.classList.add('hidden');
        });
    }

    // ── MODAL SELETOR DE PASTAS ────────────────────────────────
    const folderModal = document.getElementById('folder-modal');
    const btnPickFolder = document.getElementById('btn-pick-folder');
    const btnCloseFolderModal = document.getElementById('btn-close-folder-modal');
    const btnCancelFolderModal = document.getElementById('btn-cancel-folder-modal');
    const fsDrivesList = document.getElementById('fs-drives-list');
    const fsCurrentPathInput = document.getElementById('fs-current-path-input');
    const btnFsUp = document.getElementById('btn-fs-up');
    const btnFsGo = document.getElementById('btn-fs-go');
    const fsFolderList = document.getElementById('fs-folder-list');
    const btnFsNative = document.getElementById('btn-fs-native');
    const btnSelectCurrentFolder = document.getElementById('btn-select-current-folder');

    let fsCurrentPath = '';
    let fsParentPath = null;

    async function loadFsFolder(targetPath) {
        if (!fsFolderList) return;
        fsFolderList.innerHTML = '<div style="color: var(--text-muted); padding: 12px; font-size: 11px;">⏳ Carregando pastas...</div>';
        try {
            const url = targetPath ? `/api/fs/browse?path=${encodeURIComponent(targetPath)}` : '/api/fs/browse';
            const res = await fetch(url);
            const data = await res.json();
            if (data.status !== 'ok') {
                fsFolderList.innerHTML = `<div style="color: #ff6b6b; padding: 12px; font-size: 11px;">❌ ${data.message || 'Erro ao carregar pasta'}</div>`;
                return;
            }

            fsCurrentPath = data.current_path;
            fsParentPath = data.parent_path;
            if (fsCurrentPathInput) fsCurrentPathInput.value = data.current_path;

            // Renderizar Drives
            if (fsDrivesList && data.drives) {
                fsDrivesList.innerHTML = '';
                data.drives.forEach(drive => {
                    const btn = document.createElement('button');
                    btn.className = `fs-drive-btn ${fsCurrentPath.toUpperCase().startsWith(drive.toUpperCase()) ? 'active' : ''}`;
                    btn.textContent = `💾 ${drive}`;
                    btn.onclick = () => loadFsFolder(drive);
                    fsDrivesList.appendChild(btn);
                });
            }

            // Renderizar Pastas
            fsFolderList.innerHTML = '';
            if (data.folders.length === 0) {
                fsFolderList.innerHTML = '<div style="color: var(--text-muted); padding: 12px; font-size: 11px;">📁 (Nenhuma subpasta encontrada nesta pasta)</div>';
            } else {
                data.folders.forEach(folder => {
                    const row = document.createElement('div');
                    row.className = 'fs-folder-item';
                    row.innerHTML = `<span class="icon">📁</span> <span class="name">${escapeHtml(folder.name)}</span>`;
                    row.onclick = () => loadFsFolder(folder.path);
                    fsFolderList.appendChild(row);
                });
            }
        } catch (e) {
            fsFolderList.innerHTML = `<div style="color: #ff6b6b; padding: 12px; font-size: 11px;">❌ Falha na conexão: ${e}</div>`;
        }
    }

    if (btnPickFolder) {
        btnPickFolder.addEventListener('click', () => {
            const currentVal = document.getElementById('work-dir-input')?.value?.trim();
            if (folderModal) folderModal.classList.remove('hidden');
            loadFsFolder(currentVal || '');
        });
    }

    if (btnCloseFolderModal) {
        btnCloseFolderModal.addEventListener('click', () => {
            if (folderModal) folderModal.classList.add('hidden');
        });
    }

    if (btnCancelFolderModal) {
        btnCancelFolderModal.addEventListener('click', () => {
            if (folderModal) folderModal.classList.add('hidden');
        });
    }

    if (btnFsUp) {
        btnFsUp.addEventListener('click', () => {
            if (fsParentPath) loadFsFolder(fsParentPath);
        });
    }

    if (btnFsGo) {
        btnFsGo.addEventListener('click', () => {
            const custom = fsCurrentPathInput?.value?.trim();
            if (custom) loadFsFolder(custom);
        });
    }

    if (fsCurrentPathInput) {
        fsCurrentPathInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const custom = fsCurrentPathInput.value.trim();
                if (custom) loadFsFolder(custom);
            }
        });
    }

    if (btnSelectCurrentFolder) {
        btnSelectCurrentFolder.addEventListener('click', () => {
            const input = document.getElementById('work-dir-input');
            const chosen = fsCurrentPathInput?.value?.trim() || fsCurrentPath;
            if (input && chosen) {
                input.value = chosen;
                sendSettingUpdate('active_work_dir', chosen);
                appendLog(`[CONFIG] Pasta alvo definida: ${chosen}`, 'success');
            }
            if (folderModal) folderModal.classList.add('hidden');
        });
    }

    if (btnFsNative) {
        btnFsNative.addEventListener('click', async () => {
            const orig = btnFsNative.textContent;
            btnFsNative.textContent = '⏳ Abrindo...';
            btnFsNative.disabled = true;
            try {
                const res = await fetch('/api/pick-folder', { method: 'POST' });
                const data = await res.json();
                if (data.status === 'ok' && data.path) {
                    const input = document.getElementById('work-dir-input');
                    if (input) input.value = data.path;
                    sendSettingUpdate('active_work_dir', data.path);
                    appendLog(`[CONFIG] Pasta alvo selecionada via Windows: ${data.path}`, 'success');
                    if (folderModal) folderModal.classList.add('hidden');
                } else if (data.status === 'error') {
                    appendLog(`[CONFIG] ${data.message}`, 'warning');
                }
            } catch (e) {
                appendLog(`[CONFIG] Falha: ${e}`, 'error');
            } finally {
                btnFsNative.textContent = orig;
                btnFsNative.disabled = false;
            }
        });
    }

    connectWebSocket();
});
