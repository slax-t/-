const supabaseUrl =
    window.SLAX_SUPABASE_URL ??
    import.meta.env?.VITE_SUPABASE_URL ??
    "https://dqhvecotzsvnzdfwozgb.supabase.co";
const supabaseKey =
    window.SLAX_SUPABASE_PUBLISHABLE_KEY ??
    import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "sb_publishable_GpEKccLRvtua6-rbIJoaaw_HHwQblRR";
const db = { supabaseUrl, supabaseKey };
const appId = 'slax-console-v1'; 

const supabaseBaseHeaders = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`
};

function buildRestUrl(table, filters = {}, options = {}) {
    const params = new URLSearchParams();
    params.set('select', options.select ?? '*');
    for (const [field, value] of Object.entries(filters)) {
        params.set(field, `eq.${String(value)}`);
    }
    if (typeof options.limit === 'number') params.set('limit', String(options.limit));
    if (typeof options.order === 'string') params.set('order', options.order);
    if (typeof options.on_conflict === 'string') params.set('on_conflict', options.on_conflict);
    return `${supabaseUrl}/rest/v1/${table}?${params.toString()}`;
}

async function supabaseRequest(table, { method = 'GET', filters = {}, body, options = {}, prefer } = {}) {
    const url = buildRestUrl(table, filters, options);
    const headers = { ...supabaseBaseHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers['Prefer'] = prefer;
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;
    if (!response.ok) {
        const message = data?.message ?? `Supabase REST error: ${response.status}`;
        throw new Error(message);
    }
    return data;
}

function collection(_db, ...segments) {
    return { path: segments.join('/') };
}
function doc(collectionRef, id) {
    return { ...collectionRef, id, ref: { ...collectionRef, id } };
}
function where(field, operator, value) { return { type: 'where', field, operator, value }; }
function limit(count) { return { type: 'limit', count }; }
function query(collectionRef, ...clauses) { return { ...collectionRef, clauses }; }
function serverTimestamp() { return new Date().toISOString(); }

function resolveCollectionMeta(path) {
    if (path.endsWith('/app_users')) return { table: 'app_users' };
    if (path.endsWith('/messages')) return { table: 'messages' };
    if (path.includes('/voice_sessions/')) {
        const parts = path.split('/');
        const idx = parts.indexOf('voice_sessions');
        return { table: 'voice_sessions', channel: parts[idx + 1] };
    }
    if (path.includes('/voice_signals/')) {
        const parts = path.split('/');
        const idx = parts.indexOf('voice_signals');
        return { table: 'voice_signals', recipient_session_id: parts[idx + 1] };
    }
    return { table: null };
}
function applyClauses(builder, clauses = []) {
    const q = { ...builder };
    for (const clause of clauses) {
        if (clause.type === 'where' && clause.operator === '==') q.filters[clause.field] = clause.value;
        if (clause.type === 'limit') q.limit = clause.count;
    }
    return q;
}
function wrapDoc(row, customRef) {
    return {
        id: row.id ?? row.session_id ?? row.username,
        data: () => row,
        ref: customRef ?? row
    };
}
async function getDocs(queryRef) {
    const meta = resolveCollectionMeta(queryRef.path);
    if (!meta.table) return { empty: true, docs: [], forEach: () => {} };
    let qb = { filters: {} };
    if (meta.channel) qb.filters.channel = meta.channel;
    if (meta.recipient_session_id) qb.filters.recipient_session_id = meta.recipient_session_id;
    qb = applyClauses(qb, queryRef.clauses);
    const data = await supabaseRequest(meta.table, {
        method: 'GET',
        filters: qb.filters,
        options: { limit: qb.limit }
    }) ?? [];
    const docs = data.map((row) => wrapDoc(row));
    return { empty: docs.length === 0, docs, forEach: (fn) => docs.forEach(fn) };
}
async function setDoc(docRef, payload) {
    const meta = resolveCollectionMeta(docRef.path);
    if (meta.table === 'app_users') {
        await supabaseRequest('app_users', {
            method: 'POST',
            body: [{ ...payload, username: docRef.id }],
            options: { select: '*', on_conflict: 'username' },
            prefer: 'resolution=merge-duplicates,return=representation'
        });
        return;
    }
    if (meta.table === 'voice_sessions') {
        await supabaseRequest('voice_sessions', {
            method: 'POST',
            body: [{ ...payload, channel: meta.channel, session_id: docRef.id }],
            options: { select: '*', on_conflict: 'channel,session_id' },
            prefer: 'resolution=merge-duplicates,return=representation'
        });
        return;
    }
    throw new Error(`Unsupported setDoc path: ${docRef.path}`);
}
async function updateDoc(docRef, payload) {
    const meta = resolveCollectionMeta(docRef.path);
    if (meta.table === 'app_users') {
        await supabaseRequest('app_users', {
            method: 'PATCH',
            filters: { username: docRef.id },
            body: payload,
            prefer: 'return=representation'
        });
        return;
    }
    if (meta.table === 'voice_sessions') {
        await supabaseRequest('voice_sessions', {
            method: 'PATCH',
            filters: { channel: meta.channel, session_id: docRef.id },
            body: payload,
            prefer: 'return=representation'
        });
        return;
    }
    throw new Error(`Unsupported updateDoc path: ${docRef.path}`);
}
async function addDoc(collectionRef, payload) {
    const meta = resolveCollectionMeta(collectionRef.path);
    if (meta.table === 'messages') {
        const data = await supabaseRequest('messages', {
            method: 'POST',
            body: [payload],
            prefer: 'return=representation'
        });
        return wrapDoc(data?.[0] ?? {});
    }
    if (meta.table === 'voice_signals') {
        const data = await supabaseRequest('voice_signals', {
            method: 'POST',
            body: [{ ...payload, recipient_session_id: meta.recipient_session_id }],
            prefer: 'return=representation'
        });
        return wrapDoc(data?.[0] ?? {});
    }
    throw new Error(`Unsupported addDoc path: ${collectionRef.path}`);
}
async function deleteDoc(docRef) {
    const baseRef = docRef.ref ?? docRef;
    const meta = resolveCollectionMeta(baseRef.path ?? '');
    if (meta.table === 'voice_sessions') {
        await supabaseRequest('voice_sessions', {
            method: 'DELETE',
            filters: { channel: meta.channel, session_id: baseRef.id }
        });
        return;
    }
    if (baseRef.table === 'voice_signals') {
        await supabaseRequest('voice_signals', {
            method: 'DELETE',
            filters: { id: baseRef.id }
        });
        return;
    }
    throw new Error('Unsupported deleteDoc reference');
}
async function getDoc(docRef) {
    const meta = resolveCollectionMeta(docRef.path);
    if (meta.table === 'app_users') {
        const data = await supabaseRequest('app_users', {
            method: 'GET',
            filters: { username: docRef.id },
            options: { limit: 1 }
        });
        const row = data?.[0] ?? null;
        return { exists: () => Boolean(row), data: () => row };
    }
    return { exists: () => false, data: () => null };
}
function onSnapshot(queryRef, callback) {
    let isActive = true;
    let previousRows = [];
    const poll = async () => {
        if (!isActive) return;
        try {
            const snapshot = await getDocs(queryRef);
            const currentRows = snapshot.docs.map((d) => d.data());
            const hasSignals = queryRef.path.includes('/voice_signals/');
            if (hasSignals) {
                const previousIds = new Set(previousRows.map((row) => row.id));
                const added = currentRows.filter((row) => !previousIds.has(row.id)).map((row) => ({
                    type: 'added',
                    doc: wrapDoc(row, { table: 'voice_signals', id: row.id })
                }));
                callback({
                    docs: snapshot.docs,
                    forEach: (fn) => snapshot.docs.forEach(fn),
                    docChanges: () => added
                });
            } else {
                callback(snapshot);
            }
            previousRows = currentRows;
        } catch (error) {
            console.error('Realtime poll error:', error);
        }
    };
    poll();
    const timer = setInterval(poll, 1500);
    return () => {
        isActive = false;
        clearInterval(timer);
    };
}

// WebRTC Config
const iceServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ]
};

// --- УНИКАЛЬНЫЙ ID СЕССИИ ---
let localSessionId = sessionStorage.getItem('slax_session_id');
if (!localSessionId) {
    localSessionId = crypto.randomUUID();
    sessionStorage.setItem('slax_session_id', localSessionId);
}

// --- СОСТОЯНИЕ ---
let currentUser = null; 
let currentUsername = "GUEST"; 
let authMode = 'login'; 
let currentChannel = "main";
let messagesUnsubscribe = null; 

let localStream = null;
let screenStream = null;
let isSharingScreen = false;
let screenSenders = {};

let currentVoiceChannel = null;

const peerConnections = {};
let voiceSessionUnsubscribe = null;
let signalUnsubscribes = {};
let isMicMuted = false;

let isSidebarOpen = false;
let isAdminPanelOpen = false;
let adminEventsUnsubscribe = null;
let adminBroadcastsUnsubscribe = null;
let isRainbowEventActive = false;
let isSilentEventActive = false;
let isMusicEventActive = false;
let currentMusicName = null;
let lastProcessedBroadcastId = null;

let userSettings = {
    theme: 'green',
    voiceMessagesEnabled: true,
    notifications: true
};

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingStartTime = 0;
let recordingTimer = null;
let audioContext = null;
let analyser = null;
let dataArray = null;
let animationFrame = null;

let userPlugins = {};
let activePlugins = {};
const availablePlugins = {
    'font-jetbrains': {
        name: 'JetBrains Mono Font',
        type: 'font',
        css: `body, .font-mono { font-family: 'JetBrains Mono', monospace !important; font-size: 0.95rem; }`,
        description: 'Чистый моноширинный шрифт JetBrains Mono'
    },
    'font-orbitron': {
        name: 'Orbitron Font',
        type: 'font',
        css: `body, .font-mono { font-family: 'Orbitron', sans-serif !important; letter-spacing: 0.5px; font-weight: 400; } input, button { font-family: 'Orbitron', sans-serif !important; }`,
        description: 'Футуристический шрифт Orbitron'
    },
    'theme-matrix': {
        name: 'Matrix Theme',
        type: 'theme',
        css: `:root { --terminal-color: #00ff00 !important; --terminal-glow: #00ff00 !important; --terminal-bg: #001100 !important; --scanline: rgba(0, 255, 0, 0.08) !important; } body { text-shadow: 0 0 8px #00ff00 !important; } .border-green-800 { border-color: #003300 !important; } .bg-green-900\\/10 { background-color: rgba(0, 30, 0, 0.2) !important; }`,
        description: 'Стиль Matrix (зелёный на чёрном)'
    },
    'theme-cyberpunk': {
        name: 'Cyberpunk Theme',
        type: 'theme',
        css: `:root { --terminal-color: #ff00ff !important; --terminal-glow: #ff00ff !important; --terminal-bg: #0a001a !important; --scanline: rgba(255, 0, 255, 0.06) !important; } body { text-shadow: 0 0 8px #ff00ff !important; } .border-green-800 { border-color: #660066 !important; } .bg-green-900\\/10 { background-color: rgba(80, 0, 80, 0.2) !important; } .text-green-500 { color: #ff00ff !important; } .text-green-400 { color: #ff66ff !important; } .text-green-300 { color: #ff99ff !important; }`,
        description: 'Киберпанк стиль (розовый на тёмном)'
    }
};

// --- DOM ЭЛЕМЕНТЫ ---
const loginScreen = document.getElementById('login-screen');
const mainInterface = document.getElementById('main-interface');
const usernameInput = document.getElementById('username-input');
const pinInput = document.getElementById('pin-input');
const authMainBtn = document.getElementById('auth-main-btn');
const authSwitchBtn = document.getElementById('auth-switch-btn');
const authModeTitle = document.getElementById('auth-mode-title');
const loginError = document.getElementById('login-error');
const chatContainer = document.getElementById('chat-messages');
const messageInput = document.getElementById('message-input');
const displayUsername = document.getElementById('display-username');
const displayUid = document.getElementById('display-uid');
const voiceStatusPanel = document.getElementById('voice-status-panel');
const currentVoiceName = document.getElementById('current-voice-name');
const micToggleButton = document.getElementById('mic-toggle-btn');
const screenToggleButton = document.getElementById('screen-toggle-btn');
const notificationArea = document.getElementById('notification-area'); 
const sidebar = document.getElementById('sidebar'); 
const sidebarBackdrop = document.getElementById('sidebar-backdrop'); 
const floatingVideosContainer = document.getElementById('floating-videos-container');

let adminButton = null, adminPanel = null;
let settingsButton = null, settingsPanel = null;
let voiceMessageButton = null, voiceRecordingPanel = null, voiceVisualizer = null;
let backgroundMusic = null;
let pluginsButton = null, pluginsPanel = null;

// --- АДАПТИВНОСТЬ ---
window.toggleSidebar = function() {
    isSidebarOpen = !isSidebarOpen;
    if (isSidebarOpen) {
        sidebar.classList.remove('-translate-x-full');
        sidebar.classList.add('translate-x-0');
        sidebarBackdrop.classList.remove('hidden');
    } else {
        sidebar.classList.remove('translate-x-0');
        sidebar.classList.add('-translate-x-full');
        sidebarBackdrop.classList.add('hidden');
    }
}

// --- АВТОРИЗАЦИЯ ---
async function initAuth() {
    try { currentUser = { id: localSessionId }; }
    catch (e) { console.error("SLAX AUTH ERROR:", e); loginError.textContent = "КРИТИЧЕСКАЯ ОШИБКА: СБОЙ АВТОРИЗАЦИИ SUPABASE."; }
}
initAuth();
displayUid.textContent = `SID: ${localSessionId.slice(0, 8).toUpperCase()}`; 
loginError.textContent = "СОЕДИНЕНИЕ УСТАНОВЛЕНО. ВВЕДИТЕ ДАННЫЕ.";

authMainBtn.addEventListener('click', handleAuthAction);
authSwitchBtn.addEventListener('click', toggleAuthMode);
pinInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleAuthAction(); });

function toggleAuthMode() {
    authMode = authMode === 'login' ? 'register' : 'login';
    if (authMode === 'login') {
        authModeTitle.textContent = ">> LOG IN REQUIRED";
        authMainBtn.textContent = "[ CONNECT ]";
        authSwitchBtn.textContent = "[ SWITCH TO REGISTER ]";
        pinInput.placeholder = "enter_password_6_16_chars";
    } else {
        authModeTitle.textContent = ">> REGISTER NEW USER";
        authMainBtn.textContent = "[ CREATE USER ]";
        authSwitchBtn.textContent = "[ SWITCH TO LOG IN ]";
        pinInput.placeholder = "create_password_6_16_chars";
    }
    loginError.textContent = "ВВЕДИТЕ ДАННЫЕ.";
    playTone(1500, 0.05);
}

function handleAuthAction() {
    if (authMode === 'login') attemptLogin();
    else attemptRegistration();
}

async function validateInput(name, password) {
    if (!currentUser) { loginError.textContent = "ОШИБКА: АВТОРИЗАЦИЯ SUPABASE ОЖИДАЕТСЯ."; return false; }
    if (!name || name.length < 3 || name.length > 12) { loginError.textContent = "ОШИБКА: НИКНЕЙМ ДОЛЖЕН БЫТЬ 3-12 СИМВОЛОВ."; return false; }
    if (!password || password.length < 6 || password.length > 16) { loginError.textContent = "ОШИБКА: ПАРОЛЬ ДОЛЖЕН БЫТЬ 6-16 СИМВОЛОВ."; return false; }
    return true;
}

async function attemptLogin() {
    const name = usernameInput.value.trim().toUpperCase();
    const password = pinInput.value.trim();
    if (!await validateInput(name, password)) return;

    loginError.textContent = "АУТЕНТИФИКАЦИЯ...";
    const usersRef = collection(db, 'artifacts', appId, 'public', 'data', 'app_users');
    const q = query(usersRef, where('username', '==', name), limit(1));
    
    try {
        const snapshot = await getDocs(q);
        if (snapshot.empty) { loginError.textContent = "ОШИБКА: ПОЛЬЗОВАТЕЛЬ НЕ НАЙДЕН. ЗАРЕГИСТРИРУЙТЕСЬ."; playTone(200, 0.3); return; }
        
        const userData = snapshot.docs[0].data();
        if (userData.password === password) {
            currentUsername = name;
            if (userData.settings) userSettings = { ...userSettings, ...userData.settings };
            if (userData.plugins) { userPlugins = userData.plugins; applyUserPlugins(); }
            grantAccess();
        } else { loginError.textContent = "ОШИБКА: ПАРОЛЬ НЕВЕРЕН."; playTone(200, 0.3); }
    } catch (err) { console.error("DB Login Error:", err); loginError.textContent = "КРИТИЧЕСКАЯ ОШИБКА БД: СМ. КОНСОЛЬ."; }
}

async function attemptRegistration() {
    const name = usernameInput.value.trim().toUpperCase();
    const password = pinInput.value.trim();
    if (!await validateInput(name, password)) return;

    loginError.textContent = "ПОПЫТКА РЕГИСТРАЦИИ...";
    const usersRef = collection(db, 'artifacts', appId, 'public', 'data', 'app_users');
    const q = query(usersRef, where('username', '==', name), limit(1));

    try {
        const snapshot = await getDocs(q);
        if (!snapshot.empty) { loginError.textContent = "ОШИБКА: НИКНЕЙМ ЗАНЯТ."; playTone(200, 0.3); return; }

        await setDoc(doc(usersRef, name), {
            username: name, password: password, settings: userSettings, plugins: userPlugins, createdAt: serverTimestamp()
        });
        currentUsername = name;
        loginError.textContent = `ПОЛЬЗОВАТЕЛЬ ${name} УСПЕШНО СОЗДАН.`;
        grantAccess();
    } catch (err) { console.error("DB Registration Error:", err); loginError.textContent = "КРИТИЧЕСКАЯ ОШИБКА БД ПРИ РЕГИСТРАЦИИ."; }
}

function grantAccess() {
    displayUsername.textContent = currentUsername;
    loginScreen.classList.add('hidden');
    mainInterface.classList.remove('hidden');
    initializeAdminSystem();
    initializeSettingsSystem();
    initializeVoiceMessagesSystem();
    initializePluginsSystem();
    applyTheme(userSettings.theme);
    switchChannel(currentChannel);
    messageInput.focus();
    playTone(800, 0.1); 
}

// --- ПЛАГИНЫ ---
function initializePluginsSystem() {
    createPluginsButton();
    createPluginsPanel();
    applyUserPlugins();
}

function createPluginsButton() {
    const userInfo = document.querySelector('.p-3.border-t-2.border-green-900');
    if (!userInfo) return;
    pluginsButton = document.createElement('button');
    pluginsButton.id = 'plugins-button';
    pluginsButton.className = 'mr-2 text-purple-500 hover:text-purple-300 transition-colors text-sm';
    pluginsButton.innerHTML = 'PLUGINS';
    pluginsButton.title = 'Плагины';
    pluginsButton.onclick = togglePluginsPanel;
    if (settingsButton) settingsButton.after(pluginsButton);
    else {
        const userContainer = userInfo.querySelector('.flex.items-center');
        if (userContainer) userContainer.insertBefore(pluginsButton, userContainer.firstChild);
    }
}

function createPluginsPanel() {
    pluginsPanel = document.createElement('div');
    pluginsPanel.id = 'plugins-panel';
    pluginsPanel.className = 'fixed inset-0 z-50 hidden flex items-center justify-center bg-black/90';
    pluginsPanel.innerHTML = `
        <div class="w-11/12 max-w-3xl max-h-[90vh] overflow-y-auto border-2 border-purple-600 bg-black/95 p-6 shadow-[0_0_30px_rgba(128,0,255,0.5)]">
            <div class="flex justify-between items-center mb-4">
                <h2 class="text-xl font-bold text-purple-400">>> СИСТЕМА ПЛАГИНОВ</h2>
                <button onclick="togglePluginsPanel()" class="text-purple-500 hover:text-purple-300 text-lg">[ X ]</button>
            </div>
            <div class="h-px w-full bg-purple-900 mb-6"></div>
            <div class="mb-8">
                <h3 class="text-lg font-bold text-purple-300 mb-4 border-b border-purple-800 pb-2">ДОСТУПНЫЕ ПЛАГИНЫ</h3>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="p-4 border-2 border-purple-800 rounded-lg">
                        <div class="flex justify-between items-center mb-2">
                            <h4 class="font-bold text-purple-300">JetBrains Mono Font</h4>
                            <label class="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" id="plugin-font-jetbrains" class="sr-only peer">
                                <div class="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                            </label>
                        </div>
                        <p class="text-sm text-purple-600 mb-3">Чистый моноширинный шрифт JetBrains Mono</p>
                        <div class="text-xs text-purple-700">Тип: Шрифт</div>
                    </div>
                    <div class="p-4 border-2 border-purple-800 rounded-lg">
                        <div class="flex justify-between items-center mb-2">
                            <h4 class="font-bold text-purple-300">Orbitron Font</h4>
                            <label class="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" id="plugin-font-orbitron" class="sr-only peer">
                                <div class="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                            </label>
                        </div>
                        <p class="text-sm text-purple-600 mb-3">Футуристический шрифт Orbitron</p>
                        <div class="text-xs text-purple-700">Тип: Шрифт</div>
                    </div>
                    <div class="p-4 border-2 border-purple-800 rounded-lg">
                        <div class="flex justify-between items-center mb-2">
                            <h4 class="font-bold text-purple-300">Matrix Theme</h4>
                            <label class="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" id="plugin-theme-matrix" class="sr-only peer">
                                <div class="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                            </label>
                        </div>
                        <p class="text-sm text-purple-600 mb-3">Стиль Matrix (зелёный на чёрном)</p>
                        <div class="text-xs text-purple-700">Тип: Тема</div>
                    </div>
                    <div class="p-4 border-2 border-purple-800 rounded-lg">
                        <div class="flex justify-between items-center mb-2">
                            <h4 class="font-bold text-purple-300">Cyberpunk Theme</h4>
                            <label class="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" id="plugin-theme-cyberpunk" class="sr-only peer">
                                <div class="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                            </label>
                        </div>
                        <p class="text-sm text-purple-600 mb-3">Киберпанк стиль (розовый на тёмном)</p>
                        <div class="text-xs text-purple-700">Тип: Тема</div>
                    </div>
                </div>
            </div>
            <div class="mb-8">
                <h3 class="text-lg font-bold text-purple-300 mb-4 border-b border-purple-800 pb-2">ЗАГРУЗКА СВОЕГО ПЛАГИНА</h3>
                <div class="p-4 border-2 border-purple-800 rounded-lg">
                    <div class="mb-4">
                        <label class="block text-purple-400 mb-2">Название плагина:</label>
                        <input type="text" id="plugin-name" class="w-full bg-black border border-purple-700 text-purple-300 p-2 rounded" placeholder="Мой крутой плагин">
                    </div>
                    <div class="mb-4">
                        <label class="block text-purple-400 mb-2">CSS код:</label>
                        <textarea id="plugin-css" class="w-full h-40 bg-black border border-purple-700 text-purple-300 p-2 rounded font-mono text-sm" placeholder="/* Ваш CSS код здесь */"></textarea>
                    </div>
                    <div class="flex justify-between items-center">
                        <div>
                            <label class="text-sm text-purple-600">
                                <input type="checkbox" id="plugin-keep-after-logout" class="mr-2">
                                Сохранять после выхода
                            </label>
                        </div>
                        <div class="space-x-2">
                            <button onclick="testPlugin()" class="px-4 py-2 border border-purple-600 bg-purple-900/30 hover:bg-purple-700 transition-colors text-sm">ТЕСТ</button>
                            <button onclick="saveCustomPlugin()" class="px-4 py-2 border border-purple-600 bg-purple-900/30 hover:bg-purple-700 transition-colors text-sm">СОХРАНИТЬ</button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="h-px w-full bg-purple-900 mt-6 mb-4"></div>
            <div class="flex justify-between">
                <button onclick="savePluginSettings()" class="px-6 py-2 border border-purple-600 bg-purple-900/30 hover:bg-purple-700 hover:text-black transition-colors font-bold">СОХРАНИТЬ НАСТРОЙКИ</button>
                <button onclick="togglePluginsPanel()" class="px-6 py-2 border border-gray-600 hover:bg-gray-800 transition-colors">ОТМЕНА</button>
            </div>
        </div>
    `;
    document.body.appendChild(pluginsPanel);
    updatePluginSwitches();
    document.querySelectorAll('#plugins-panel input[type="checkbox"][id^="plugin-"]').forEach(checkbox => {
        checkbox.addEventListener('change', function() {
            const pluginId = this.id.replace('plugin-', '');
            if (availablePlugins[pluginId]) {
                if (this.checked) activatePlugin(pluginId);
                else deactivatePlugin(pluginId);
            }
        });
    });
}

window.togglePluginsPanel = function() {
    if (!pluginsPanel) return;
    const isOpen = pluginsPanel.classList.contains('hidden');
    if (isOpen) {
        pluginsPanel.classList.remove('hidden');
        pluginsPanel.classList.add('flex');
        updatePluginSwitches();
        playTone(1200, 0.1);
    } else {
        pluginsPanel.classList.remove('flex');
        pluginsPanel.classList.add('hidden');
        playTone(800, 0.1);
    }
}

function updatePluginSwitches() {
    for (const pluginId in availablePlugins) {
        const checkbox = document.getElementById(`plugin-${pluginId}`);
        if (checkbox) checkbox.checked = userPlugins[pluginId] === true;
    }
}

function applyUserPlugins() {
    document.querySelectorAll('.plugin-style').forEach(el => el.remove());
    for (const pluginId in userPlugins) {
        if (userPlugins[pluginId] && availablePlugins[pluginId]) activatePlugin(pluginId, true);
    }
}

function activatePlugin(pluginId, skipSave = false) {
    if (!availablePlugins[pluginId]) return;
    const plugin = availablePlugins[pluginId];
    const style = document.createElement('style');
    style.className = 'plugin-style';
    style.id = `plugin-${pluginId}`;
    style.textContent = plugin.css;
    document.head.appendChild(style);
    activePlugins[pluginId] = true;
    if (!skipSave) { userPlugins[pluginId] = true; savePluginSettings(); }
    addSystemMessage(`ПЛАГИН "${plugin.name}" АКТИВИРОВАН`, false);
}

function deactivatePlugin(pluginId) {
    const style = document.getElementById(`plugin-${pluginId}`);
    if (style) style.remove();
    delete activePlugins[pluginId];
    userPlugins[pluginId] = false;
    savePluginSettings();
    addSystemMessage(`ПЛАГИН "${availablePlugins[pluginId]?.name}" ОТКЛЮЧЕН`, false);
}

window.testPlugin = function() {
    const css = document.getElementById('plugin-css').value;
    if (!css.trim()) { addSystemMessage("ВВЕДИТЕ CSS КОД", true); return; }
    const tempStyle = document.createElement('style');
    tempStyle.id = 'plugin-test';
    tempStyle.textContent = css;
    document.head.appendChild(tempStyle);
    addSystemMessage("ПЛАГИН ПРОТЕСТИРОВАН (удалится через 10 сек)", false);
    setTimeout(() => {
        const style = document.getElementById('plugin-test');
        if (style) style.remove();
        addSystemMessage("ТЕСТОВЫЙ ПЛАГИН УДАЛЕН", false);
    }, 10000);
}

window.saveCustomPlugin = async function() {
    const name = document.getElementById('plugin-name').value.trim();
    const css = document.getElementById('plugin-css').value.trim();
    const keepAfterLogout = document.getElementById('plugin-keep-after-logout').checked;
    if (!name || !css) { addSystemMessage("ЗАПОЛНИТЕ ВСЕ ПОЛЯ", true); return; }
    const pluginId = 'custom-' + Date.now();
    const customPlugins = JSON.parse(localStorage.getItem('slax_custom_plugins') || '{}');
    customPlugins[pluginId] = { name, css, keepAfterLogout };
    localStorage.setItem('slax_custom_plugins', JSON.stringify(customPlugins));
    const style = document.createElement('style');
    style.className = 'plugin-style';
    style.id = `plugin-${pluginId}`;
    style.textContent = css;
    document.head.appendChild(style);
    addSystemMessage(`СОБСТВЕННЫЙ ПЛАГИН "${name}" СОХРАНЕН`, false);
    document.getElementById('plugin-name').value = '';
    document.getElementById('plugin-css').value = '';
}

window.savePluginSettings = async function() {
    try {
        const usersRef = collection(db, 'artifacts', appId, 'public', 'data', 'app_users');
        const userDocRef = doc(usersRef, currentUsername);
        await updateDoc(userDocRef, { plugins: userPlugins });
        addSystemMessage("НАСТРОЙКИ ПЛАГИНОВ СОХРАНЕНЫ", false);
        playTone(1000, 0.1);
    } catch (error) {
        console.error("Ошибка сохранения плагинов:", error);
        addSystemMessage("ОШИБКА СОХРАНЕНИЯ ПЛАГИНОВ", true);
    }
}

// --- НАСТРОЙКИ ---
function initializeSettingsSystem() {
    createSettingsButton();
    createSettingsPanel();
}

function createSettingsButton() {
    const userInfo = document.querySelector('.p-3.border-t-2.border-green-900');
    if (!userInfo) return;
    settingsButton = document.createElement('button');
    settingsButton.id = 'settings-button';
    settingsButton.className = 'mr-2 text-yellow-500 hover:text-yellow-300 transition-colors text-sm';
    settingsButton.innerHTML = 'SETTINGS';
    settingsButton.title = 'Настройки';
    settingsButton.onclick = toggleSettingsPanel;
    const userContainer = userInfo.querySelector('.flex.items-center');
    if (userContainer) userContainer.insertBefore(settingsButton, userContainer.firstChild);
}

function createSettingsPanel() {
    settingsPanel = document.createElement('div');
    settingsPanel.id = 'settings-panel';
    settingsPanel.className = 'fixed inset-0 z-50 hidden flex items-center justify-center bg-black/90';
    settingsPanel.innerHTML = `
        <div class="w-11/12 max-w-md max-h-[90vh] overflow-y-auto border-2 border-blue-600 bg-black/95 p-6 shadow-[0_0_30px_rgba(0,100,255,0.5)]">
            <div class="flex justify-between items-center mb-4">
                <h2 class="text-xl font-bold text-blue-400">>> НАСТРОЙКИ ПОЛЬЗОВАТЕЛЯ</h2>
                <button onclick="toggleSettingsPanel()" class="text-blue-500 hover:text-blue-300 text-lg">[ X ]</button>
            </div>
            <div class="h-px w-full bg-blue-900 mb-6"></div>
            <div class="mb-8">
                <h3 class="text-lg font-bold text-blue-300 mb-4 border-b border-blue-800 pb-2">ЦВЕТОВАЯ ТЕМА</h3>
                <div class="grid grid-cols-3 gap-3">
                    <button id="theme-green" onclick="changeTheme('green')" class="p-3 border-2 border-green-600 bg-green-900/20 hover:bg-green-800 transition-colors text-center">
                        <div class="text-green-400 font-bold">ЗЕЛЕНАЯ</div>
                        <div class="text-xs text-green-600 mt-1">КЛАССИЧЕСКАЯ</div>
                    </button>
                    <button id="theme-white" onclick="changeTheme('white')" class="p-3 border-2 border-gray-600 bg-gray-900/20 hover:bg-gray-800 transition-colors text-center">
                        <div class="text-gray-300 font-bold">БЕЛАЯ</div>
                        <div class="text-xs text-gray-600 mt-1">МОНОХРОМ</div>
                    </button>
                    <button id="theme-red" onclick="changeTheme('red')" class="p-3 border-2 border-red-600 bg-red-900/20 hover:bg-red-800 transition-colors text-center">
                        <div class="text-red-400 font-bold">КРАСНАЯ</div>
                        <div class="text-xs text-red-600 mt-1">АВАРИЙНАЯ</div>
                    </button>
                </div>
            </div>
            <div class="mb-8">
                <h3 class="text-lg font-bold text-blue-300 mb-4 border-b border-blue-800 pb-2">ДРУГИЕ НАСТРОЙКИ</h3>
                <div class="space-y-4">
                    <div class="flex items-center justify-between">
                        <div>
                            <div class="font-bold text-blue-400">ГОЛОСОВЫЕ СООБЩЕНИЯ</div>
                            <div class="text-xs text-blue-600">Разрешить отправку голосовых сообщений</div>
                        </div>
                        <label class="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" id="voice-messages-toggle" class="sr-only peer" ${userSettings.voiceMessagesEnabled ? 'checked' : ''}>
                            <div class="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                        </label>
                    </div>
                    <div class="flex items-center justify-between">
                        <div>
                            <div class="font-bold text-blue-400">УВЕДОМЛЕНИЯ</div>
                            <div class="text-xs text-blue-600">Показывать системные уведомления</div>
                        </div>
                        <label class="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" id="notifications-toggle" class="sr-only peer" ${userSettings.notifications ? 'checked' : ''}>
                            <div class="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                        </label>
                    </div>
                </div>
            </div>
            <div class="h-px w-full bg-blue-900 mt-6 mb-4"></div>
            <div class="flex justify-between">
                <button onclick="saveSettings()" class="px-6 py-2 border border-blue-600 bg-blue-900/30 hover:bg-blue-700 hover:text-black transition-colors font-bold">СОХРАНИТЬ</button>
                <button onclick="toggleSettingsPanel()" class="px-6 py-2 border border-gray-600 hover:bg-gray-800 transition-colors">ОТМЕНА</button>
            </div>
        </div>
    `;
    document.body.appendChild(settingsPanel);
    const voiceToggle = document.getElementById('voice-messages-toggle');
    const notificationsToggle = document.getElementById('notifications-toggle');
    if (voiceToggle) voiceToggle.addEventListener('change', function() { userSettings.voiceMessagesEnabled = this.checked; });
    if (notificationsToggle) notificationsToggle.addEventListener('change', function() { userSettings.notifications = this.checked; });
}

window.toggleSettingsPanel = function() {
    if (!settingsPanel) return;
    const isOpen = settingsPanel.classList.contains('hidden');
    if (isOpen) {
        settingsPanel.classList.remove('hidden');
        settingsPanel.classList.add('flex');
        playTone(1200, 0.1);
    } else {
        settingsPanel.classList.remove('flex');
        settingsPanel.classList.add('hidden');
        playTone(800, 0.1);
    }
}

window.changeTheme = function(theme) {
    document.querySelectorAll('[id^="theme-"]').forEach(btn => {
        btn.classList.remove('border-4', 'bg-opacity-40');
        btn.classList.add('border-2', 'bg-opacity-20');
    });
    const themeBtn = document.getElementById(`theme-${theme}`);
    if (themeBtn) {
        themeBtn.classList.remove('border-2', 'bg-opacity-20');
        themeBtn.classList.add('border-4', 'bg-opacity-40');
    }
    applyTheme(theme);
}

function applyTheme(theme) {
    document.body.classList.remove('theme-green', 'theme-white', 'theme-red');
    document.body.classList.add(`theme-${theme}`);
    updateCSSVariables(theme);
}

function updateCSSVariables(theme) {
    const root = document.documentElement;
    switch(theme) {
        case 'white':
            root.style.setProperty('--terminal-color', '#ffffff');
            root.style.setProperty('--terminal-glow', '#ffffff');
            root.style.setProperty('--terminal-bg', '#000000');
            root.style.setProperty('--scanline', 'rgba(255, 255, 255, 0.04)');
            root.style.setProperty('--header-bg', '#222');
            break;
        case 'red':
            root.style.setProperty('--terminal-color', '#ff0000');
            root.style.setProperty('--terminal-glow', '#ff0000');
            root.style.setProperty('--terminal-bg', '#0a0000');
            root.style.setProperty('--scanline', 'rgba(255, 0, 0, 0.04)');
            root.style.setProperty('--header-bg', '#220000');
            break;
        case 'green':
        default:
            root.style.setProperty('--terminal-color', '#0f0');
            root.style.setProperty('--terminal-glow', '#0f0');
            root.style.setProperty('--terminal-bg', '#000500');
            root.style.setProperty('--scanline', 'rgba(0, 255, 0, 0.04)');
            root.style.setProperty('--header-bg', '#001100');
            break;
    }
}

window.saveSettings = async function() {
    try {
        const usersRef = collection(db, 'artifacts', appId, 'public', 'data', 'app_users');
        const userDocRef = doc(usersRef, currentUsername);
        await updateDoc(userDocRef, { settings: userSettings });
        applyTheme(userSettings.theme);
        addSystemMessage("НАСТРОЙКИ СОХРАНЕНЫ", false);
        playTone(1000, 0.1);
        toggleSettingsPanel();
    } catch (error) {
        console.error("Ошибка сохранения настроек:", error);
        addSystemMessage("ОШИБКА СОХРАНЕНИЯ НАСТРОЕК", true);
    }
}

// --- ГОЛОСОВЫЕ СООБЩЕНИЯ ---
function initializeVoiceMessagesSystem() {
    if (!userSettings.voiceMessagesEnabled) return;
    createVoiceMessageButton();
    createVoiceRecordingPanel();
}

function createVoiceMessageButton() {
    const inputArea = document.querySelector('.flex.items-center.bg-green-900\\/10');
    if (!inputArea) return;
    voiceMessageButton = document.createElement('button');
    voiceMessageButton.id = 'voice-message-button';
    voiceMessageButton.className = 'ml-3 text-red-400 hover:text-red-300 transition-colors text-lg';
    voiceMessageButton.innerHTML = 'MICROPHONE';
    voiceMessageButton.title = 'Голосовое сообщение (удерживайте для записи)';
    voiceMessageButton.onmousedown = startVoiceRecording;
    voiceMessageButton.onmouseup = stopVoiceRecording;
    voiceMessageButton.onmouseleave = stopVoiceRecording;
    voiceMessageButton.ontouchstart = (e) => { e.preventDefault(); startVoiceRecording(); };
    voiceMessageButton.ontouchend = (e) => { e.preventDefault(); stopVoiceRecording(); };
    inputArea.appendChild(voiceMessageButton);
}

function createVoiceRecordingPanel() {
    voiceRecordingPanel = document.createElement('div');
    voiceRecordingPanel.id = 'voice-recording-panel';
    voiceRecordingPanel.className = 'fixed bottom-24 left-1/2 transform -translate-x-1/2 z-50 hidden bg-black/90 border-2 border-red-600 p-4 rounded-lg shadow-[0_0_20px_rgba(255,0,0,0.5)] max-w-[90vw]';
    voiceRecordingPanel.innerHTML = `
        <div class="text-center mb-3">
            <div class="text-red-400 font-bold text-lg">ЗАПИСЬ ГОЛОСОВОГО СООБЩЕНИЯ</div>
            <div id="recording-timer" class="text-red-300 text-sm">0:00 / 0:30</div>
        </div>
        <div class="flex items-center justify-center mb-4">
            <div id="voice-visualizer" class="flex items-end h-16 space-x-1"></div>
        </div>
        <div class="flex justify-center space-x-4">
            <button id="cancel-recording" class="px-4 py-2 border border-gray-600 hover:bg-gray-800 transition-colors">ОТМЕНА</button>
            <button id="send-recording" class="px-4 py-2 border border-red-600 bg-red-900/30 hover:bg-red-700 transition-colors hidden">ОТПРАВИТЬ</button>
        </div>
    `;
    document.body.appendChild(voiceRecordingPanel);
    voiceVisualizer = document.getElementById('voice-visualizer');
    for (let i = 0; i < 40; i++) {
        const bar = document.createElement('div');
        bar.className = 'w-1 bg-red-500 transition-all duration-100';
        bar.style.height = '4px';
        voiceVisualizer.appendChild(bar);
    }
    document.getElementById('cancel-recording').addEventListener('click', cancelVoiceRecording);
    document.getElementById('send-recording').addEventListener('click', sendVoiceMessage);
}

async function startVoiceRecording() {
    if (!userSettings.voiceMessagesEnabled) { addSystemMessage("ГОЛОСОВЫЕ СООБЩЕНИЯ ОТКЛЮЧЕНЫ В НАСТРОЙКАХ", true); return; }
    if (isRecording) return;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 });
        audioChunks = [];
        mediaRecorder.ondataavailable = (event) => { if (event.data.size > 0) audioChunks.push(event.data); };
        mediaRecorder.onstop = () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
            document.getElementById('send-recording').classList.remove('hidden');
            stream.getTracks().forEach(track => track.stop());
            if (animationFrame) cancelAnimationFrame(animationFrame);
            if (audioContext) audioContext.close();
        };
        mediaRecorder.start(100);
        isRecording = true;
        recordingStartTime = Date.now();
        voiceRecordingPanel.classList.remove('hidden');
        startRecordingTimer();
        startVoiceVisualizer(stream);
        playTone(800, 0.1);
    } catch (error) {
        console.error("Ошибка доступа к микрофону:", error);
        addSystemMessage("ОШИБКА: НЕ УДАЛОСЬ ПОЛУЧИТЬ ДОСТУП К МИКРОФОНУ", true);
    }
}

function startRecordingTimer() {
    const timerElement = document.getElementById('recording-timer');
    recordingTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
        const seconds = elapsed % 60;
        const minutes = Math.floor(elapsed / 60);
        timerElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')} / 0:30`;
        if (elapsed >= 30) stopVoiceRecording();
    }, 1000);
}

function startVoiceVisualizer(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    function updateVisualizer() {
        if (!isRecording) return;
        analyser.getByteFrequencyData(dataArray);
        const bars = voiceVisualizer.children;
        for (let i = 0; i < bars.length; i++) {
            const dataIndex = Math.floor(i * (bufferLength / bars.length));
            const value = dataArray[dataIndex] || 0;
            const height = 4 + (value / 255) * 60;
            bars[i].style.height = `${height}px`;
            bars[i].style.backgroundColor = value > 200 ? '#ff0000' : value > 150 ? '#ff5500' : value > 100 ? '#ffaa00' : '#ff5555';
        }
        animationFrame = requestAnimationFrame(updateVisualizer);
    }
    updateVisualizer();
}

function stopVoiceRecording() {
    if (!isRecording) return;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    isRecording = false;
    if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
    playTone(600, 0.1);
}

function cancelVoiceRecording() {
    stopVoiceRecording();
    voiceRecordingPanel.classList.add('hidden');
    document.getElementById('send-recording').classList.add('hidden');
    const bars = voiceVisualizer.children;
    for (let bar of bars) { bar.style.height = '4px'; bar.style.backgroundColor = '#ff5555'; }
    addSystemMessage("ЗАПИСЬ ОТМЕНЕНА", false);
}

async function sendVoiceMessage() {
    if (audioChunks.length === 0) { addSystemMessage("НЕТ ЗАПИСАННЫХ ДАННЫХ", true); return; }
    try {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
        const reader = new FileReader();
        reader.onloadend = async () => {
            const base64Audio = reader.result.split(',')[1];
            const duration = Math.floor((Date.now() - recordingStartTime) / 1000);
            await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'messages'), {
                text: `[ГОЛОСОВОЕ СООБЩЕНИЕ ${duration}с]`,
                user: currentUsername,
                uid: currentUser.uid,
                channel: currentChannel,
                type: 'voice',
                voiceData: base64Audio,
                duration: duration,
                timestamp: serverTimestamp()
            });
            voiceRecordingPanel.classList.add('hidden');
            document.getElementById('send-recording').classList.add('hidden');
            const bars = voiceVisualizer.children;
            for (let bar of bars) { bar.style.height = '4px'; bar.style.backgroundColor = '#ff5555'; }
            addSystemMessage("ГОЛОСОВОЕ СООБЩЕНИЕ ОТПРАВЛЕНО", false);
            playTone(1000, 0.1);
        };
        reader.readAsDataURL(audioBlob);
    } catch (error) {
        console.error("Ошибка отправки голосового сообщения:", error);
        addSystemMessage("ОШИБКА ОТПРАВКИ ГОЛОСОВОГО СООБЩЕНИЯ", true);
    }
}

function playVoiceMessage(base64Audio, duration, messageId) {
    if (isSilentEventActive) return;
    const audio = new Audio(`data:audio/webm;base64,${base64Audio}`);
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    const progressFill = document.getElementById(`progress-${messageId}`);
    const timeDisplay = document.getElementById(`time-${messageId}`);
    const visualizer = document.getElementById(`visualizer-${messageId}`);
    if (messageElement) {
        const playButton = messageElement.querySelector('button');
        if (playButton) {
            playButton.innerHTML = '<span class="text-white text-sm">PAUSE</span>';
            playButton.onclick = () => audio.pause();
            audio.addEventListener('pause', () => {
                playButton.innerHTML = '<span class="text-white text-sm">PLAY</span>';
                playButton.onclick = () => playVoiceMessage(base64Audio, duration, messageId);
            });
            audio.addEventListener('ended', () => {
                playButton.innerHTML = '<span class="text-white text-sm">PLAY</span>';
                playButton.onclick = () => playVoiceMessage(base64Audio, duration, messageId);
                if (progressFill) progressFill.style.width = '0%';
                if (timeDisplay) timeDisplay.textContent = `0:${duration}`;
                stopVisualizerAnimation(visualizer);
            });
        }
    }
    audio.addEventListener('timeupdate', () => {
        const progress = (audio.currentTime / audio.duration) * 100;
        if (progressFill) progressFill.style.width = `${progress}%`;
        if (timeDisplay) {
            const currentTime = Math.floor(audio.currentTime);
            const totalTime = Math.floor(audio.duration || duration);
            timeDisplay.textContent = `${Math.floor(currentTime/60)}:${(currentTime%60).toString().padStart(2,'0')}/${Math.floor(totalTime/60)}:${(totalTime%60).toString().padStart(2,'0')}`;
        }
    });
    startVisualizerAnimation(visualizer, audio);
    audio.play().catch(e => { console.error("Ошибка воспроизведения:", e); addSystemMessage("ОШИБКА ВОСПРОИЗВЕДЕНИЯ", true); });
}

function startVisualizerAnimation(visualizer, audio) {
    if (!visualizer) return;
    const canvas = visualizer.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaElementSource(audio);
    const analyser = audioCtx.createAnalyser();
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    function draw() {
        const animationId = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArray);
        ctx.fillStyle = 'rgb(0,0,0)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const barWidth = (canvas.width / bufferLength) * 2.5;
        let x = 0;
        for (let i = 0; i < bufferLength; i++) {
            const barHeight = (dataArray[i] / 255) * canvas.height * 0.8;
            ctx.fillStyle = `rgb(${255 - dataArray[i]}, ${dataArray[i]}, 100)`;
            ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
            x += barWidth + 1;
        }
    }
    draw();
}

function stopVisualizerAnimation(visualizer) {
    if (visualizer) {
        const canvas = visualizer.querySelector('canvas');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }
}

// --- СООБЩЕНИЯ ---
messageInput.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
        const text = messageInput.value.trim();
        if (!text) return;
        if (!currentUsername || currentUsername === 'GUEST') { addSystemMessage("ОШИБКА: НЕ АВТОРИЗОВАН.", true); return; }
        messageInput.value = '';
        try {
            await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'messages'), {
                text: text,
                user: currentUsername,
                uid: currentUser.uid,
                channel: currentChannel,
                timestamp: serverTimestamp()
            });
            playTone(600, 0.03);
        } catch (err) {
            console.error("Send error", err);
            addSystemMessage("ОШИБКА ОТПРАВКИ.", true);
        }
    }
});

function switchChannel(channel) {
    currentChannel = channel;
    document.querySelectorAll('[data-channel]').forEach(li => li.classList.remove('channel-active'));
    const activeLi = document.querySelector(`[data-channel="${channel}"]`);
    if (activeLi) activeLi.classList.add('channel-active');
    document.getElementById('channel-title').textContent = `>> #${channel.toUpperCase()}`;
    if (messagesUnsubscribe) messagesUnsubscribe();
    const messagesRef = collection(db, 'artifacts', appId, 'public', 'data', 'messages');
    const q = query(messagesRef, where('channel', '==', channel));
    messagesUnsubscribe = onSnapshot(q, (snapshot) => {
        chatContainer.innerHTML = '';
        snapshot.docs.forEach(doc => {
            const msg = doc.data();
            const msgEl = document.createElement('div');
            msgEl.className = 'border-l-2 border-green-800 pl-2 my-1';
            if (msg.type === 'voice') {
                const duration = msg.duration || 0;
                msgEl.innerHTML = `
                    <div class="voice-message p-2 border border-blue-600 bg-blue-900/10 rounded" data-message-id="${doc.id}">
                        <div class="flex items-center space-x-2">
                            <button class="text-white">PLAY</button>
                            <div class="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                                <div id="progress-${doc.id}" class="h-full bg-blue-500 transition-all" style="width: 0%"></div>
                            </div>
                            <div id="time-${doc.id}" class="text-xs">0:${duration}</div>
                        </div>
                        <div id="visualizer-${doc.id}" class="mt-2 h-8 bg-black rounded overflow-hidden"><canvas width="300" height="32"></canvas></div>
                    </div>
                `;
                const playBtn = msgEl.querySelector('button');
                playBtn.onclick = () => playVoiceMessage(msg.voiceData, duration, doc.id);
            } else {
                msgEl.innerHTML = `<span class="text-green-300">[${msg.user}]</span> ${msg.text}`;
            }
            chatContainer.appendChild(msgEl);
        });
        chatContainer.scrollTop = chatContainer.scrollHeight;
    });
}

// --- WEBRTC ГОЛОСОВОЙ ЧАТ ---
const voiceRef = (channel) => collection(db, 'artifacts', appId, 'public', 'data', 'voice_sessions', channel, 'users');
const signalingCollectionRef = (sessionId) => collection(db, 'artifacts', appId, 'public', 'data', 'voice_signals', sessionId, 'incoming_signals'); 

window.handleVoiceAction = function(voiceId) {
    if (currentVoiceChannel === voiceId) leaveVoice();
    else joinVoice(voiceId);
    if (isSidebarOpen && window.innerWidth < 768) toggleSidebar();
};

async function joinVoice(voiceId) {
    if (!currentUser) return;
    if (currentVoiceChannel) await leaveVoice();
    currentVoiceChannel = voiceId;
    voiceStatusPanel.classList.remove('hidden');
    currentVoiceName.textContent = voiceId.toUpperCase();
    addSystemMessage(`ЗАХВАТ МИКРОФОНА...`);
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        micToggleButton.textContent = 'MIC: ON';
        isMicMuted = false;
        await setDoc(doc(voiceRef(voiceId), localSessionId), {
            username: currentUsername,
            sessionId: localSessionId,
            uid: currentUser.uid, 
            joinedAt: serverTimestamp(),
            isMicMuted: false
        });
        subscribeToVoiceSession(voiceId);
        subscribeToSignaling();
        addSystemMessage(`ГОЛОСОВОЙ УЗЕЛ ${voiceId.toUpperCase()} АКТИВЕН.`);
        playTone(400, 0.1);
        setTimeout(() => playTone(600, 0.2), 150);
    } catch (err) {
        console.error("Ошибка при подключении к GS:", err);
        addSystemMessage("ОШИБКА: НЕ УДАЛОСЬ ЗАХВАТИТЬ МИКРОФОН. ПРОВЕРЬТЕ РАЗРЕШЕНИЯ.", true);
        leaveVoice(); 
    }
}

window.leaveVoice = async function() {
    if (!currentVoiceChannel) { addSystemMessage(`ОШИБКА: ВЫ НЕ ПОДКЛЮЧЕНЫ К ГОЛОСОВОМУ КАНАЛУ.`, true); return; }
    if (isSharingScreen) await stopScreenShare();
    const channelToLeave = currentVoiceChannel; 
    if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; }
    Object.keys(peerConnections).forEach(sessionId => {
        const pc = peerConnections[sessionId];
        if (pc) pc.close();
        removeMediaWindow(sessionId, true);
        delete peerConnections[sessionId];
        delete screenSenders[sessionId];
    });
    if (voiceSessionUnsubscribe) { voiceSessionUnsubscribe(); voiceSessionUnsubscribe = null; }
    for (const key in signalUnsubscribes) {
        if(signalUnsubscribes[key]) signalUnsubscribes[key]();
        delete signalUnsubscribes[key];
    }
    signalUnsubscribes = {}; 
    if (channelToLeave) {
        await deleteDoc(doc(voiceRef(channelToLeave), localSessionId)).catch(e => console.warn("Не удалось удалить сессию:", e));
    }
    currentVoiceChannel = null;
    voiceStatusPanel.classList.add('hidden');
    addSystemMessage(`ГОЛОСОВОЙ УЗЕЛ ОТКЛЮЧЕН.`);
    playTone(300, 0.2);
}

window.addEventListener('beforeunload', async () => {
    if (currentVoiceChannel) {
        const voiceSessionDocRef = doc(voiceRef(currentVoiceChannel), localSessionId);
        try { fetch(voiceSessionDocRef.path, { method: 'DELETE', keepalive: true }); } catch(e) { }
    }
});

function subscribeToVoiceSession(voiceId) {
    if (voiceSessionUnsubscribe) voiceSessionUnsubscribe();
    const q = voiceRef(voiceId);
    voiceSessionUnsubscribe = onSnapshot(q, (snapshot) => {
        const users = [];
        const currentPeers = new Set(Object.keys(peerConnections));
        const activePeers = new Set();
        snapshot.forEach(doc => {
            const userData = doc.data();
            if (userData.sessionId !== localSessionId) { 
                users.push({ username: userData.username, sessionId: userData.sessionId });
                activePeers.add(userData.sessionId);
                const pc = peerConnections[userData.sessionId];
                if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
                    const isInitiator = localSessionId < userData.sessionId;
                    createPeerConnection(userData.sessionId, isInitiator); 
                    addSystemMessage(`ПОЛЬЗОВАТЕЛЬ ${userData.username} ПРИСОЕДИНИЛСЯ.`);
                }
            }
        });
        currentPeers.forEach(sessionId => {
            if (!activePeers.has(sessionId)) {
                const pc = peerConnections[sessionId];
                if (pc) pc.close();
                delete peerConnections[sessionId];
                delete screenSenders[sessionId];
                if (signalUnsubscribes[sessionId]) signalUnsubscribes[sessionId]();
                delete signalUnsubscribes[sessionId];
                removeMediaWindow(sessionId, true);
                addSystemMessage(`ПОЛЬЗОВАТЕЛЬ ${sessionId.slice(0, 8).toUpperCase()} ВЫШЕЛ.`);
            }
        });
        const usersHtml = users.map(u => `<div class="text-green-300" data-session-id="${u.sessionId}">>> ${u.username}</div>`).join('');
        const voiceLi = document.querySelector(`li[data-voice="${voiceId}"]`);
        if (voiceLi) {
            voiceLi.querySelector('.voice-users').innerHTML = usersHtml;
            voiceLi.querySelector('.voice-count').textContent = users.length + 1; 
        }
    }, (err) => console.error("Ошибка подписки на сессию:", err));
}

function subscribeToSignaling() {
    const q = signalingCollectionRef(localSessionId);
    if (signalUnsubscribes['local']) signalUnsubscribes['local']();
    signalUnsubscribes['local'] = onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type !== 'added') return; 
            const signalDoc = change.doc;
            const data = signalDoc.data();
            if (data.senderSessionId === localSessionId) {
                try { await deleteDoc(signalDoc.ref); } catch(e) { }
                return;
            }
            if (data.offer) {
                addSystemMessage(`ПРИНЯТО ПРЕДЛОЖЕНИЕ ОТ ${data.senderUsername} - ОБРАБОТКА...`);
                await handleOffer(data.senderSessionId, data.offer, data.senderUsername);
            } else if (data.answer) {
                addSystemMessage(`ПРИНЯТ ОТВЕТ ОТ ${data.senderUsername} - ОБРАБОТКА...`);
                await handleAnswer(data.senderSessionId, data.answer);
            } else if (data.candidate) {
                await handleCandidate(data.senderSessionId, data.candidate);
            }
            try { await deleteDoc(signalDoc.ref); } catch (e) { console.error("Ошибка удаления сигнала:", e); }
        });
    }, (err) => console.error("Ошибка подписки на сигналы:", err));
}

async function createPeerConnection(targetSessionId, isInitiator) {
    const pc = new RTCPeerConnection(iceServers);
    peerConnections[targetSessionId] = pc;
    if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    if (screenStream && isSharingScreen) {
        const videoTrack = screenStream.getVideoTracks()[0];
        if (videoTrack) screenSenders[targetSessionId] = pc.addTrack(videoTrack, screenStream);
        screenStream.getAudioTracks().forEach(track => pc.addTrack(track, screenStream));
    }
    pc.ontrack = (event) => {
        const stream = event.streams[0];
        const track = event.track;
        const voiceLi = document.querySelector(`li[data-voice="${currentVoiceChannel}"]`);
        const userDiv = voiceLi ? voiceLi.querySelector(`.voice-users div[data-session-id="${targetSessionId}"]`) : null;
        const targetUsername = userDiv ? userDiv.textContent.replace('>> ', '').trim() : targetSessionId.slice(0, 8).toUpperCase(); 
        if (track.kind === 'audio') ensureMediaWindow(targetSessionId, targetUsername, stream, 'audio');
        else if (track.kind === 'video') ensureMediaWindow(targetSessionId, targetUsername, stream, 'video');
    };
    pc.onnegotiationneeded = async () => {
        if (isInitiator) {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await sendSignal({ offer: pc.localDescription.toJSON(), senderSessionId: localSessionId, senderUsername: currentUsername, type: 'offer' }, targetSessionId);
            } catch (e) { console.error("Ошибка onnegotiationneeded:", e); }
        }
    };
    pc.onicecandidate = async (event) => {
        if (event.candidate) {
            await sendSignal({ candidate: event.candidate.toJSON(), senderSessionId: localSessionId, senderUsername: currentUsername, type: 'candidate' }, targetSessionId);
        }
    };
    if (isInitiator) {
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await sendSignal({ offer: pc.localDescription.toJSON(), senderSessionId: localSessionId, senderUsername: currentUsername, type: 'offer' }, targetSessionId);
        } catch (e) { console.error("Ошибка создания OFFER:", e); }
    }
}

async function handleOffer(senderSessionId, offer, senderUsername) {
    let pc = peerConnections[senderSessionId];
    if (!pc) { createPeerConnection(senderSessionId, false); pc = peerConnections[senderSessionId]; }
    if (!pc) return; 
    try {
        if (pc.signalingState !== 'stable') {
            if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: "rollback" });
            else if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-remote-offer') return;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal({ answer: pc.localDescription.toJSON(), senderSessionId: localSessionId, senderUsername: currentUsername, type: 'answer' }, senderSessionId);
        addSystemMessage(`ОТПРАВЛЕН ОТВЕТ ${senderUsername}.`);
    } catch (e) {
        console.error("ОШИБКА ОБРАБОТКИ OFFER:", e);
        addSystemMessage(`ОШИБКА: СБОЙ ОБРАБОТКИ ПРЕДЛОЖЕНИЯ ОТ ${senderUsername}.`, true);
    }
}

async function handleAnswer(senderSessionId, answer) {
    const pc = peerConnections[senderSessionId];
    if (!pc) return;
    if (pc.signalingState === 'have-local-offer') {
        try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); }
        catch (e) { console.error("ОШИБКА ОБРАБОТКИ ANSWER:", e); addSystemMessage(`ОШИБКА: СБОЙ ОБРАБОТКИ ОТВЕТА.`, true); }
    }
}

async function handleCandidate(senderSessionId, candidate) {
    const pc = peerConnections[senderSessionId];
    if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
        catch (e) { console.error('Ошибка ICE-кандидата:', e); }
    }
}

async function sendSignal(signalData, targetSessionId) {
    if (!targetSessionId || typeof targetSessionId !== 'string') return;
    const recipientCollection = signalingCollectionRef(targetSessionId); 
    try { await addDoc(recipientCollection, signalData); } 
    catch (e) { console.error(`Ошибка отправки сигнала к ${targetSessionId}:`, e); }
}

function makeDraggable(element) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    const dragHeader = element.querySelector('.drag-handle');
    function dragMouseDown(e) {
        e = e || window.event;
        e.preventDefault();
        pos3 = e.clientX || e.touches[0].clientX;
        pos4 = e.clientY || e.touches[0].clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
        document.ontouchend = closeDragElement;
        document.ontouchmove = elementDrag;
        element.classList.add('dragging');
    }
    function elementDrag(e) {
        e = e || window.event;
        e.preventDefault();
        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        const clientY = e.clientY || (e.touches && e.touches[0].clientY);
        if (!clientX || !clientY) return;
        pos1 = pos3 - clientX;
        pos2 = pos4 - clientY;
        pos3 = clientX;
        pos4 = clientY;
        element.style.top = (element.offsetTop - pos2) + "px";
        element.style.left = (element.offsetLeft - pos1) + "px";
    }
    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
        document.ontouchend = null;
        document.ontouchmove = null;
        element.classList.remove('dragging');
    }
    if (dragHeader) { dragHeader.onmousedown = dragMouseDown; dragHeader.ontouchstart = dragMouseDown; }
    else { element.onmousedown = dragMouseDown; element.ontouchstart = dragMouseDown; }
}

function makeResizable(element) {
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'resize-handle absolute bottom-0 right-0 w-6 h-6 cursor-se-resize text-green-500 text-xs flex items-center justify-center';
    resizeHandle.innerHTML = 'RESIZE';
    resizeHandle.title = 'Изменение размера (зажмите и тяните)';
    element.appendChild(resizeHandle);
    let startX, startY, startWidth, startHeight;
    function startResize(e) {
        e.preventDefault(); e.stopPropagation();
        startX = e.clientX || e.touches[0].clientX;
        startY = e.clientY || e.touches[0].clientY;
        startWidth = parseInt(document.defaultView.getComputedStyle(element).width, 10);
        startHeight = parseInt(document.defaultView.getComputedStyle(element).height, 10);
        document.documentElement.addEventListener('mousemove', resize);
        document.documentElement.addEventListener('mouseup', stopResize);
        document.documentElement.addEventListener('touchmove', resize);
        document.documentElement.addEventListener('touchend', stopResize);
        element.classList.add('resizing');
    }
    function resize(e) {
        e.preventDefault();
        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        const clientY = e.clientY || (e.touches && e.touches[0].clientY);
        if (!clientX || !clientY) return;
        const dx = clientX - startX;
        const dy = clientY - startY;
        const newWidth = Math.max(200, Math.min(window.innerWidth - 50, startWidth + dx));
        const newHeight = Math.max(150, Math.min(window.innerHeight - 100, startHeight + dy));
        element.style.width = newWidth + 'px';
        element.style.height = newHeight + 'px';
    }
    function stopResize() {
        document.documentElement.removeEventListener('mousemove', resize);
        document.documentElement.removeEventListener('mouseup', stopResize);
        document.documentElement.removeEventListener('touchmove', resize);
        document.documentElement.removeEventListener('touchend', stopResize);
        element.classList.remove('resizing');
        const sessionId = element.id.replace('window-', '');
        const sizes = JSON.parse(localStorage.getItem('window_sizes') || '{}');
        sizes[sessionId] = { width: element.style.width, height: element.style.height };
        localStorage.setItem('window_sizes', JSON.stringify(sizes));
    }
    resizeHandle.addEventListener('mousedown', startResize);
    resizeHandle.addEventListener('touchstart', startResize);
}

function ensureMediaWindow(sessionId, username, stream, type, isLocal = false) {
    const windowId = `window-${sessionId}`;
    const mediaId = `${sessionId}-${type}`;
    let windowElement = document.getElementById(windowId);
    if (type === 'audio') {
        let audioElement = document.getElementById(mediaId);
        if (!audioElement) {
            audioElement = document.createElement('audio'); 
            audioElement.id = mediaId;
            audioElement.autoplay = true;
            audioElement.style.display = 'none';
            document.body.appendChild(audioElement);
            if (!isLocal) addSystemMessage(`ПОЛУЧЕН АУДИО ПОТОК ОТ ${username}.`);
        }
        audioElement.srcObject = stream;
        return;
    }
    if (!windowElement) {
        windowElement = document.createElement('div');
        windowElement.id = windowId;
        windowElement.className = "floating-window fixed border-2 border-green-700 bg-black/95 shadow-[0_0_15px_rgba(0,255,0,0.5)] z-50 transition-transform duration-300 ease-in-out";
        const sizes = JSON.parse(localStorage.getItem('window_sizes') || '{}');
        if (sizes[sessionId]) {
            windowElement.style.width = sizes[sessionId].width;
            windowElement.style.height = sizes[sessionId].height;
        } else {
            windowElement.style.width = '400px';
            windowElement.style.height = '300px';
        }
        const numWindows = document.querySelectorAll('.floating-window').length;
        const offsetX = (numWindows % 4) * 30;
        const offsetY = (numWindows % 3) * 30;
        windowElement.style.top = `${100 + offsetY}px`;
        windowElement.style.left = `${50 + offsetX}px`;
        const displayUsername = isLocal ? 'YOUR SCREEN' : `${username}'s SCREEN`;
        windowElement.innerHTML = `
            <div class="drag-handle p-1.5 cursor-move bg-green-900/50 flex justify-between items-center text-xs font-bold border-b border-green-700">
                <span class="text-green-300">${isLocal ? '>> ' : '<< '}${displayUsername}</span>
                <button onclick="removeMediaWindow('${sessionId}', true)" class="text-red-500 hover:text-red-300 transition-colors">[ X ]</button>
            </div>
            <div class="video-content w-full h-full" style="height: calc(100% - 30px);">
                <video id="${mediaId}" autoplay playsinline class="w-full h-full object-contain"></video>
            </div>
        `;
        floatingVideosContainer.appendChild(windowElement);
        makeDraggable(windowElement);
        makeResizable(windowElement);
        if (!isLocal) addSystemMessage(`ПОЛУЧЕН ВИДЕО ПОТОК (ЭКРАН) ОТ ${username}.`);
    }
    const videoElement = windowElement.querySelector('video');
    if (videoElement) {
        videoElement.srcObject = stream;
        stream.getVideoTracks()[0].onended = () => { if (!isLocal) removeMediaWindow(sessionId, true); };
    }
}

window.removeMediaWindow = function(sessionId, isManualClose = false) {
    const audioId = `${sessionId}-audio`;
    const audioElement = document.getElementById(audioId);
    if (audioElement) audioElement.remove();
    const windowId = `window-${sessionId}`;
    const windowElement = document.getElementById(windowId);
    if (windowElement) windowElement.remove();
    if (sessionId === localSessionId && isSharingScreen && isManualClose) stopScreenShare(); 
}

window.toggleMic = function() {
    if (!localStream) return;
    isMicMuted = !isMicMuted;
    localStream.getAudioTracks().forEach(track => { track.enabled = !isMicMuted; });
    micToggleButton.textContent = isMicMuted ? 'MIC: OFF' : 'MIC: ON';
    addSystemMessage(isMicMuted ? 'МИКРОФОН ВЫКЛЮЧЕН.' : 'МИКРОФОН ВКЛЮЧЕН.');
    playTone(1000, 0.05);
    if (currentVoiceChannel) {
        updateDoc(doc(voiceRef(currentVoiceChannel), localSessionId), { isMicMuted: isMicMuted });
    }
}

window.toggleScreenShare = function() {
    if (isSharingScreen) stopScreenShare();
    else startScreenShare();
}

async function startScreenShare() {
    if (!currentVoiceChannel) { addSystemMessage("ОШИБКА: СНАЧАЛА ПОДКЛЮЧИТЕСЬ К ГОЛСОВОМУ КАНАЛУ.", true); return; }
    if (isSharingScreen) return;
    addSystemMessage("ЗАХВАТ ЭКРАНА...");
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        screenStream = stream;
        isSharingScreen = true;
        screenToggleButton.textContent = 'SCREEN: ON';
        screenToggleButton.classList.add('bg-green-600', 'hover:bg-green-700');
        screenToggleButton.classList.remove('bg-green-900/20', 'hover:bg-green-800');
        const videoTrack = screenStream.getVideoTracks()[0];
        const audioTrack = screenStream.getAudioTracks()[0];
        ensureMediaWindow(localSessionId, currentUsername, stream, 'video', true);
        Object.keys(peerConnections).forEach(targetSessionId => {
            const pc = peerConnections[targetSessionId];
            if (videoTrack) screenSenders[targetSessionId] = pc.addTrack(videoTrack, screenStream);
            if (audioTrack) pc.addTrack(audioTrack, screenStream);
        });
        videoTrack.onended = stopScreenShare;
        addSystemMessage("ДЕМОНСТРАЦИЯ ЭКРАНА НАЧАТА.");
        playTone(1500, 0.1);
    } catch (e) {
        console.error("Ошибка захвата экрана:", e);
        addSystemMessage("ОШИБКА: НЕ УДАЛОСЬ ЗАХВАТИТЬ ЭКРАН.", true);
        isSharingScreen = false;
        screenToggleButton.textContent = 'SCREEN: OFF';
        screenToggleButton.classList.remove('bg-green-600', 'hover:bg-green-700');
        screenToggleButton.classList.add('bg-green-900/20', 'hover:bg-green-800');
    }
}

async function stopScreenShare() {
    if (!isSharingScreen || !screenStream) return;
    addSystemMessage("ОСТАНОВКА ДЕМОНСТРАЦИИ ЭКРАНА...");
    Object.keys(peerConnections).forEach(targetSessionId => {
        const pc = peerConnections[targetSessionId];
        const videoSender = screenSenders[targetSessionId];
        if (videoSender) pc.removeTrack(videoSender);
        pc.getSenders().forEach(sender => {
            if (sender.track && screenStream.getAudioTracks().includes(sender.track)) pc.removeTrack(sender);
        });
    });
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
    removeMediaWindow(localSessionId, false);
    isSharingScreen = false;
    screenToggleButton.textContent = 'SCREEN: OFF';
    screenToggleButton.classList.remove('bg-green-600', 'hover:bg-green-700');
    screenToggleButton.classList.add('bg-green-900/20', 'hover:bg-green-800');
    addSystemMessage("ДЕМОНСТРАЦИЯ ЭКРАНА ОСТАНОВЛЕНА.");
    playTone(300, 0.1);
}

// --- УТИЛИТЫ ---
const AudioContext = window.AudioContext || window.webkitAudioContext;
const ctx = new AudioContext();

function playTone(freq, dur) {
    if (isSilentEventActive) return;
    try {
        if(ctx.state === 'suspended') ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'square';
        osc.frequency.value = freq;
        gain.gain.value = 0.03;
        osc.start();
        osc.stop(ctx.currentTime + dur);
    } catch(e) {}
}

function addSystemMessage(text, isError = false) {
    if (!userSettings.notifications) return;
    const isAdminEvent = text.includes("RAINBOW MODE:") || text.includes("SILENT MODE:") || text.includes("BACKGROUND MUSIC:") || text.includes("ФОНОВАЯ МУЗЫКА");
    if (isAdminEvent && currentUsername !== 'WINTER') return;
    const notification = document.createElement('div');
    notification.className = `notification-item text-sm border-l-4 pl-2 ${isError ? 'text-red-300 border-red-500' : 'text-green-300 border-green-500'}`;
    notification.textContent = `>> СИСТЕМА: ${text}`;
    notificationArea.appendChild(notification);
    setTimeout(() => {
        notification.classList.add('fade-out');
        setTimeout(() => notification.remove(), 200); 
    }, 2500); 
}

// --- ИНИЦИАЛИЗАЦИЯ АДМИНКИ (пустая, но есть) ---
function initializeAdminSystem() { /* заглушка */ }

// --- ЭКСПОРТ ГЛОБАЛЬНЫХ ФУНКЦИЙ ---
window.toggleSidebar = toggleSidebar;
window.handleVoiceAction = handleVoiceAction;
window.leaveVoice = leaveVoice;
window.toggleMic = toggleMic;
window.toggleScreenShare = toggleScreenShare;
window.playVoiceMessage = playVoiceMessage;
window.removeMediaWindow = removeMediaWindow;
