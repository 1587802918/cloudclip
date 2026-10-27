const authInput = document.getElementById('auth-input');
const authBtn = document.getElementById('auth-btn');
const authError = document.getElementById('auth-error');
const textArea = document.getElementById('clipboard-text');
const statusIndicator = document.getElementById('status-indicator');
const previewImg = document.getElementById('preview-img');
const uploadHint = document.getElementById('upload-hint');
const fileDropZone = document.getElementById('file-drop-zone');
const fileInfoArea = document.getElementById('file-info-area');
const fileNameDisplay = document.getElementById('file-name-display');
const fileMetaDisplay = document.getElementById('file-meta-display');
const fileDownloadLink = document.getElementById('file-download-link');

let socket;
let syncTimer;
let reconnectTimer;
let isTyping = false;
let authenticated = false;

function lock() {
    authenticated = false;
    clearTimeout(syncTimer);
    clearTimeout(reconnectTimer);
    isTyping = false;
    if (socket) { socket.close(); socket = undefined; }
    document.getElementById('auth-overlay').classList.remove('hidden');
    document.getElementById('main-container').classList.remove('active');
    document.getElementById('main-container').inert = true;
    textArea.value = '';
    previewImg.removeAttribute('src');
    previewImg.style.display = 'none';
    uploadHint.style.display = 'flex';
    clearFileInfoOnUI();
    fileNameDisplay.textContent = '';
    fileMetaDisplay.textContent = '';
    fileDownloadLink.removeAttribute('href');
    fileDownloadLink.removeAttribute('download');
    document.getElementById('file-input').value = '';
    document.getElementById('general-file-input').value = '';
    statusIndicator.textContent = '未登录';
    authInput.focus();
}

async function request(url, options = {}) {
    const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) {
        if (response.status === 401 && url !== '/api/auth/login') lock();
        throw new Error(data.error || '请求失败，请重试');
    }
    return data;
}

async function init() {
    // 清理旧版本在浏览器中保存的明文密码。
    localStorage.removeItem('clip_auth');
    lock();
    try { await request('/api/auth/session'); await unlock(); } catch { /* 等待输入密码。 */ }
}

async function verifyAuth() {
    if (authBtn.disabled) return;
    authBtn.disabled = true;
    authError.style.opacity = '0';
    try {
        await request('/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: authInput.value })
        });
        authInput.value = '';
        await unlock();
    } catch (error) {
        authError.textContent = error.message;
        authError.style.opacity = '1';
        authInput.value = '';
        authInput.focus();
    } finally { authBtn.disabled = false; }
}

async function unlock() {
    authenticated = true;
    document.getElementById('auth-overlay').classList.add('hidden');
    document.getElementById('main-container').classList.add('active');
    document.getElementById('main-container').inert = false;
    await fetchData();
    if (authenticated) connectWebSocket();
}

authInput.addEventListener('keydown', event => { if (event.key === 'Enter') verifyAuth(); });
authBtn.addEventListener('click', verifyAuth);
document.getElementById('btn-logout').addEventListener('click', async () => {
    try { await request('/api/auth/logout', { method: 'POST' }); lock(); }
    catch (error) { showToast(error.message); }
});

function connectWebSocket() {
    if (!authenticated) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(`${protocol}//${window.location.host}/`);
    socket = connection;
    connection.onopen = () => {
        if (!authenticated || socket !== connection) return connection.close();
        statusIndicator.textContent = '已连接云端';
        statusIndicator.classList.remove('offline');
        fetchData(); // 重新连接后取回断线期间错过的数据。
    };
    connection.onmessage = event => {
        if (!authenticated || socket !== connection) return;
        const data = JSON.parse(event.data);
        if (data.type === 'text') {
            if (isTyping) return;
            textArea.value = data.content;
            textArea.classList.add('receiving');
            setTimeout(() => textArea.classList.remove('receiving'), 500);
        } else if (data.type === 'image') {
            showImage(data.url); showToast('已接收最新图片');
        } else if (data.type === 'file') {
            if (data.url) {
                showFileInfoOnUI({ originalName: data.name, url: data.url, size: data.size });
                showToast('已接收最新文件');
            } else { clearFileInfoOnUI(); showToast('文件已被清空'); }
        }
    };
    connection.onclose = event => {
        if (!authenticated || socket !== connection) return;
        if (event.code === 4001) { lock(); showToast('登录已过期，请重新输入密码'); return; }
        statusIndicator.textContent = '重连中...';
        statusIndicator.classList.add('offline');
        reconnectTimer = setTimeout(async () => {
            try { await request('/api/auth/session'); connectWebSocket(); }
            catch (error) {
                if (authenticated) connection.onclose({ code: 1006 });
            }
        }, 3000);
    };
}

async function fetchData() {
    try {
        const [text, image, file] = await Promise.all([
            request('/api/clip'), request('/api/image'), request('/api/file_info')
        ]);
        if (!authenticated) return;
        if (!isTyping) textArea.value = text.content || '';
        if (image.url) showImage(image.url);
        if (file) showFileInfoOnUI(file); else clearFileInfoOnUI();
    } catch (error) { showToast(error.message); }
}

textArea.addEventListener('input', () => {
    if (!authenticated) return;
    isTyping = true;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => { await saveText(); isTyping = false; }, 2000);
});

async function saveText() {
    if (!authenticated) return false;
    statusIndicator.textContent = '保存中...';
    try {
        await request('/api/clip', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: textArea.value })
        });
        if (authenticated) statusIndicator.textContent = '已云端同步';
        return true;
    } catch (error) {
        if (authenticated) statusIndicator.textContent = '保存失败';
        showToast(error.message);
        return false;
    }
}

function showImage(url) {
    previewImg.src = url + '?t=' + Date.now();
    previewImg.style.display = 'block';
    uploadHint.style.display = 'none';
}

document.getElementById('file-input').onchange = async event => {
    const file = event.target.files[0];
    if (!file || !authenticated) return;
    const formData = new FormData();
    formData.append('image', file);
    showToast('上传中...');
    try {
        const data = await request('/api/upload', { method: 'POST', body: formData });
        if (authenticated) { showImage(data.url); showToast('上传完成'); }
    } catch (error) { showToast(error.message); }
    finally { event.target.value = ''; }
};

function showFileInfoOnUI(file) {
    fileNameDisplay.textContent = file.originalName;
    fileMetaDisplay.textContent = typeof file.size === 'number' ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : '准备就绪';
    fileDownloadLink.href = file.url;
    fileDownloadLink.setAttribute('download', file.originalName);
    fileDropZone.style.display = 'none';
    fileInfoArea.style.display = 'flex';
}

function clearFileInfoOnUI() {
    fileInfoArea.style.display = 'none';
    fileDropZone.style.display = 'flex';
}

document.getElementById('general-file-input').onchange = async event => {
    const file = event.target.files[0];
    if (!file || !authenticated) return;
    const formData = new FormData();
    formData.append('file', file);
    showToast('上传中...');
    try {
        const data = await request('/api/file_upload', { method: 'POST', body: formData });
        if (authenticated) { showFileInfoOnUI(data); showToast('上传完成'); }
    } catch (error) { showToast(error.message); }
    finally { event.target.value = ''; }
};

document.getElementById('btn-delete-file').onclick = async () => {
    try {
        await request('/api/file', { method: 'DELETE' });
        if (authenticated) { clearFileInfoOnUI(); showToast('文件已删除'); }
    } catch (error) { showToast(error.message); }
};

document.getElementById('btn-copy').onclick = () => {
    textArea.select();
    document.execCommand('copy');
    showToast('文本已复制');
};
document.getElementById('btn-sync').onclick = async () => {
    clearTimeout(syncTimer);
    if (await saveText()) showToast('手动同步完成');
    isTyping = false;
};
function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
}

init();
