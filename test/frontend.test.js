const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

// 用 DOM 和网络边界替身检查登录状态流转；不加载任何用户数据。
async function browser(t, { session = false } = {}) {
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) {
            const classes = new Set();
            const attributes = new Map();
            elements.set(id, {
                value: '', textContent: '', style: {}, disabled: false, inert: true,
                classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
                listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; },
                setAttribute: (name, value) => attributes.set(name, value),
                removeAttribute: name => attributes.delete(name),
                focus() {}, select() {}
            });
        }
        return elements.get(id);
    }
    const timers = new Set();
    const requests = [];
    const storageRemoved = [];
    let unauthorized = false;
    let failSaves = false;
    const context = vm.createContext({
        document: { getElementById: element, execCommand() {} },
        localStorage: { removeItem: key => storageRemoved.push(key) },
        window: { location: { protocol: 'http:', host: 'localhost:3000' } },
        setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); timers.add(timer); return timer; },
        clearTimeout: timer => { clearTimeout(timer); timers.delete(timer); },
        WebSocket: class {
            close() { this.closed = true; }
        },
        fetch: async (url, options) => {
            requests.push({ url, options });
            let status = 200;
            let data = {};
            if (url === '/api/auth/login') {
                const valid = JSON.parse(options.body).password === 'test-password';
                status = valid ? 200 : 401;
                data = valid ? { success: true } : { error: 'Wrong password' };
                if (valid) session = true;
            } else if (url === '/api/auth/logout') {
                session = false;
            } else if (!session || unauthorized) {
                status = 401; data = { error: 'Session expired' };
            } else if (url === '/api/clip') {
                if (options.method === 'POST' && failSaves) { status = 500; data = { error: 'Save failed' }; }
                else data = { content: 'synthetic text' };
            } else if (url === '/api/image') data = { url: null };
            else if (url === '/api/file_info') data = null;
            return { ok: status < 400, status, json: async () => data };
        }
    });
    const source = await fs.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    vm.runInContext(source.replace(/init\(\);\s*$/, 'globalThis.ready = init();'), context);
    await context.ready;
    t.after(() => {
        vm.runInContext('lock()', context);
        for (const timer of timers) clearTimeout(timer);
    });
    return {
        element, requests, storageRemoved,
        run: code => vm.runInContext(code, context),
        expire: () => { unauthorized = true; },
        failSaves: () => { failSaves = true; }
    };
}

test('page restores an existing cookie session without asking for or storing a password', async t => {
    const page = await browser(t, { session: true });
    assert.deepEqual(page.storageRemoved, ['clip_auth']);
    assert.equal(page.element('main-container').inert, false);
    assert.equal(page.element('clipboard-text').value, 'synthetic text');
    assert.ok(page.requests.every(request => request.options.credentials === 'same-origin'));
    assert.ok(!page.requests.some(request => request.url === '/api/auth/login'));
});

test('wrong password keeps the page locked; server-validated login unlocks it', async t => {
    const page = await browser(t);
    assert.equal(page.element('main-container').inert, true);
    page.element('auth-input').value = 'wrong-password';
    await page.run('verifyAuth()');
    assert.equal(page.element('main-container').inert, true);
    assert.equal(page.element('auth-error').textContent, 'Wrong password');
    page.element('auth-input').value = 'test-password';
    await page.run('verifyAuth()');
    assert.equal(page.element('main-container').inert, false);
    assert.equal(page.element('auth-input').value, '');
    assert.equal(page.element('clipboard-text').value, 'synthetic text');
    await page.element('btn-logout').listeners.click();
    assert.equal(page.element('main-container').inert, true);
    assert.equal(page.element('clipboard-text').value, '');
    assert.equal(page.run('socket'), undefined);
});

test('an expired session locks the page and a failed save never reports success', async t => {
    const page = await browser(t, { session: true });
    page.failSaves();
    assert.equal(await page.run('saveText()'), false);
    assert.equal(page.element('status-indicator').textContent, '保存失败');
    page.expire();
    assert.equal(await page.run('saveText()'), false);
    assert.equal(page.element('main-container').inert, true);
    assert.equal(page.element('clipboard-text').value, '');
    assert.equal(page.run('socket'), undefined);
});
