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

    function syncSettings(settings) {
        if (!settings) return;
        toggleSkipPerms.checked = settings.skip_permissions;
        toggleRtk.checked = settings.use_rtk;
        toggleCaveman.checked = settings.use_caveman;
        toggleAutoRotate.checked = settings.auto_rotate_quota;
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
    ['skip_permissions', 'use_rtk', 'use_caveman', 'auto_rotate_quota'].forEach(key => {
        const val = localStorage.getItem(`setting_${key}`);
        if (val !== null) {
            const isChecked = val === 'true';
            if (key === 'skip_permissions') toggleSkipPerms.checked = isChecked;
            if (key === 'use_rtk') toggleRtk.checked = isChecked;
            if (key === 'use_caveman') toggleCaveman.checked = isChecked;
            if (key === 'auto_rotate_quota') toggleAutoRotate.checked = isChecked;
        }
    });
    const savedWorkers = localStorage.getItem('setting_max_workers');
    if (savedWorkers) workersCountVal.textContent = savedWorkers;

    // Toggle Listeners
    toggleSkipPerms.addEventListener('change', (e) => sendSettingUpdate('skip_permissions', e.target.checked));
    toggleRtk.addEventListener('change', (e) => sendSettingUpdate('use_rtk', e.target.checked));
    toggleCaveman.addEventListener('change', (e) => sendSettingUpdate('use_caveman', e.target.checked));
    toggleAutoRotate.addEventListener('change', (e) => sendSettingUpdate('auto_rotate_quota', e.target.checked));

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
    promptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendPrompt();
        }
    });

    function sendPrompt() {
        const prompt = promptInput.value.trim();
        if (!prompt) return;

        appendChatMessage('user', prompt);
        promptInput.value = '';

        const workDirInput = document.getElementById('work-dir-input');
        const targetDir = workDirInput ? workDirInput.value.trim() : 'D:\\APP android teste';

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'user_prompt',
                prompt: prompt,
                work_dir: targetDir
            }));
        }
    }

    function appendChatMessage(sender, text) {
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
            card.innerHTML = `
                <div class="worker-card-header">
                    <span class="worker-card-title">👷 ${w.id}</span>
                    <span class="badge ${w.is_busy ? 'badge-purple' : 'badge-green'}">${w.is_busy ? 'Ocupado' : 'Livre'}</span>
                </div>
                <div class="worker-card-meta">
                    <div>IA CLI: <strong>${w.provider || 'antigravity'}</strong></div>
                    <div>Perfil: <strong>${w.profile || 'Padrão'}</strong></div>
                    <div>Modelo: <strong>${w.model || 'Padrão'}</strong></div>
                </div>
                <div class="worker-task-desc">
                    ${w.current_task || w.task || 'Aguardando tarefa...'}
                </div>
            `;
            workersGrid.appendChild(card);
        });
    }

    function appendLog(text, logType = 'info') {
        const line = document.createElement('div');
        line.className = `log-line ${logType}`;
        line.textContent = text;
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
        btnClearAll.addEventListener('click', () => {
            if (!confirm('Limpar terminal, chat e plano atual? Isso não afeta os arquivos do projeto.')) return;
            terminalBody.innerHTML = '<div class="log-line info">[SINGULARITY] Sistema reiniciado. Aguardando nova missão...</div>';
            chatMessages.innerHTML = '<div class="chat-bubble system-bubble"><div class="bubble-title">🪐 Singularity Multi-Agent Ready</div><p>Sistema reiniciado. Pronto para nova missão.</p></div>';
            planContainer.classList.add('hidden');
            currentPlan = null;
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
        fetchProviders();
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
            container.innerHTML = '<p style="font-size: 11px; color: var(--text-dim); font-style: italic;">Nenhuma chave cadastrada. Adicione uma chave nvapi-... para ativar a Camada 2 (DeepSeek-R1) e o Auto-Healing.</p>';
            return;
        }
        container.innerHTML = keys.map((k, i) => `
            <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(118,185,0,0.08); border: 1px solid rgba(118,185,0,0.25); padding: 6px 10px; border-radius: 5px; font-size: 11px; font-family: monospace;">
                <span style="color: #76b900;">🔑 ${k}</span>
                <button onclick="removeNvidiaKey(${i})" style="background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #f87171; border-radius: 4px; padding: 2px 7px; cursor: pointer; font-size: 10px;">✕</button>
            </div>
        `).join('');
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
        });
    }

    // Carregar chaves ao abrir o modal de providers
    const btnOpenProviders = document.getElementById('btn-providers');
    if (btnOpenProviders) {
        btnOpenProviders.addEventListener('click', fetchNvidiaKeys);
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

    connectWebSocket();
});
