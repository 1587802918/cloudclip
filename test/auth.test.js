const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createApplication } = require('../server');

const PASSWORD = 'integration-test-password';

async function fixture(t, options = {}) {
    // 每个测试使用新建的临时数据目录，不访问项目内的用户数据。
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudclip-test-'));
    const application = createApplication({ password: PASSWORD, dataDir, ...options });
    await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${application.server.address().port}`;
    t.after(async () => {
        await application.close();
        assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
        assert.ok(path.basename(dataDir).startsWith('cloudclip-test-'));
        await fs.rm(dataDir, { recursive: true, force: true });
    });
    const request = (url, init) => fetch(base + url, init);
    const json = (content, extra = {}) => ({
        method: 'POST', ...extra,
        headers: { 'Content-Type': 'application/json', ...extra.headers },
        body: JSON.stringify(content)
    });
    async function login() {
        const response = await request('/api/auth/login', json({ password: PASSWORD }));
        assert.equal(response.status, 200);
        return response.headers.get('set-cookie').split(';')[0];
    }
    return { ...application, base, dataDir, request, json, login };
}

async function connect(f, headers = {}) {
    const socket = new WebSocket(f.base.replace('http:', 'ws:') + '/', { headers });
    await once(socket, 'open');
    return socket;
}

async function rejectedSocket(f, headers = {}) {
    const socket = new WebSocket(f.base.replace('http:', 'ws:') + '/', { headers });
    socket.on('error', () => {});
    const [request, response] = await once(socket, 'unexpected-response');
    assert.equal(response.statusCode, 401);
    response.resume();
    request.destroy();
    socket.terminate();
}

test('missing or blank password refuses to create an application', () => {
    for (const password of [undefined, '', '   ']) {
        assert.throws(() => createApplication({ password }), /ACCESS_PASSWORD/);
    }
});

test('login page is public; all data endpoints and WebSocket require authentication', async t => {
    const f = await fixture(t);
    const page = await f.request('/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /btn-logout/);
    assert.match(html, /src="\/app.js"/);
    assert.doesNotMatch(html, /ACCESS_CODE/);
    assert.equal((await f.request('/app.js')).status, 200);
    for (const [url, method] of [
        ['/api/auth/session', 'GET'], ['/api/clip', 'GET'], ['/api/clip', 'POST'],
        ['/api/image', 'GET'], ['/api/upload', 'POST'], ['/api/file_info', 'GET'],
        ['/api/file_upload', 'POST'], ['/api/file', 'DELETE'],
        ['/uploads/cloud_latest.png', 'GET'], ['/files/cloud_latest_file.txt', 'GET'],
        ['/files/file_info.json', 'GET']
    ]) {
        const response = await f.request(url, { method });
        assert.equal(response.status, 401, `${method} ${url}`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    for (const url of ['/clipboard.txt', '/.env', '/server.js', '/auth.js', '/old.html']) {
        assert.equal((await f.request(url)).status, 404);
    }
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'public', 'uploads')), []);
    await rejectedSocket(f);
});

test('wrong passwords fail; successful login uses an opaque HttpOnly cookie', async t => {
    const f = await fixture(t);
    for (const password of ['incorrect', '', 123]) {
        assert.equal((await f.request('/api/auth/login', f.json({ password }))).status, 401);
    }
    const response = await f.request('/api/auth/login', f.json({ password: PASSWORD }));
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Secure/);
    assert.ok(!cookie.includes(PASSWORD));
    assert.equal((await f.request('/api/auth/session', { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
    assert.equal((await f.request('/api/clip', { headers: { Cookie: 'cloudclip_session=forged' } })).status, 401);
});

test('authenticated text, uploads, private downloads, broadcasts and deletion work', async t => {
    const f = await fixture(t);
    const cookie = await f.login();
    const headers = { Cookie: cookie };
    const socket = await connect(f, { ...headers, Origin: f.base });
    let message = once(socket, 'message');
    assert.equal((await f.request('/api/clip', f.json({ content: 'synthetic test text' }, { headers }))).status, 200);
    assert.equal(JSON.parse((await message)[0]).content, 'synthetic test text');
    assert.deepEqual(await (await f.request('/api/clip', { headers })).json(), { content: 'synthetic test text' });
    assert.equal((await f.request('/api/clip', f.json({ content: {} }, { headers }))).status, 400);

    const imageForm = new FormData();
    imageForm.append('image', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG2kAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'test.png');
    const imageResponse = await f.request('/api/upload', { method: 'POST', headers, body: imageForm });
    assert.equal(imageResponse.status, 200);
    const image = await imageResponse.json();
    assert.equal((await f.request(image.url)).status, 401);
    assert.equal((await f.request(image.url, { headers })).status, 200);
    const invalidImage = new FormData();
    invalidImage.append('image', new Blob(['<script>alert(1)</script>']), 'test.html');
    assert.equal((await f.request('/api/upload', { method: 'POST', headers, body: invalidImage })).status, 400);
    assert.equal((await f.request(image.url, { headers })).status, 200);

    const form = new FormData();
    form.append('file', new Blob(['synthetic attachment']), 'test.html');
    const response = await f.request('/api/file_upload', { method: 'POST', headers, body: form });
    assert.equal(response.status, 200);
    const file = await response.json();
    assert.equal(file.originalName, 'test.html');
    assert.equal((await f.request(file.url)).status, 401);
    const download = await f.request(file.url, { headers });
    assert.equal(await download.text(), 'synthetic attachment');
    assert.equal(download.headers.get('content-disposition'), 'attachment');
    assert.match(download.headers.get('content-security-policy'), /sandbox/);
    assert.equal(download.headers.get('cache-control'), 'no-store');
    assert.equal((await (await f.request('/api/file_info', { headers })).json()).size, file.size);
    assert.equal((await f.request('/api/file', { method: 'DELETE', headers })).status, 200);
    assert.equal(await (await f.request('/api/file_info', { headers })).json(), null);
    assert.equal((await f.request(file.url, { headers })).status, 404);
});

test('cross-origin login, mutations and WebSocket upgrades are refused', async t => {
    const f = await fixture(t);
    assert.equal((await f.request('/api/auth/login', f.json({ password: PASSWORD }, { headers: { Origin: 'https://untrusted.example' } }))).status, 403);
    const cookie = await f.login();
    assert.equal((await f.request('/api/clip', f.json({ content: 'blocked' }, { headers: { Cookie: cookie, Origin: 'https://untrusted.example' } }))).status, 403);
    assert.equal((await f.request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'null' } })).status, 403);
    await rejectedSocket(f, { Cookie: cookie, Origin: 'https://untrusted.example' });
    assert.equal((await f.request('/api/clip', f.json({ content: 'allowed' }, { headers: { Cookie: cookie, Origin: f.base } }))).status, 200);
});

test('logout revokes cookie and closes active WebSocket connections', async t => {
    const f = await fixture(t);
    const cookie = await f.login();
    const socket = await connect(f, { Cookie: cookie });
    const closed = once(socket, 'close');
    const response = await f.request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
    assert.equal((await closed)[0], 4001);
    assert.equal((await f.request('/api/clip', { headers: { Cookie: cookie } })).status, 401);
    await rejectedSocket(f, { Cookie: cookie });
});

test('expired sessions lose both HTTP and active WebSocket access', async t => {
    let clock = Date.now();
    const f = await fixture(t, { now: () => clock });
    const cookie = await f.login();
    const socket = await connect(f, { Cookie: cookie });
    const closed = once(socket, 'close');
    clock += 12 * 60 * 60 * 1000 + 1;
    assert.equal((await f.request('/api/auth/session', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await closed)[0], 4001);
    await rejectedSocket(f, { Cookie: cookie });
});

test('ten failed logins trigger a temporary per-IP limit', async t => {
    let clock = Date.now();
    const f = await fixture(t, { now: () => clock });
    for (let index = 0; index < 10; index++) {
        assert.equal((await f.request('/api/auth/login', f.json({ password: 'wrong' }))).status, 401);
    }
    const blocked = await f.request('/api/auth/login', f.json({ password: PASSWORD }));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '900');
    clock += 15 * 60 * 1000 + 1;
    await f.login();
});

test('HTTPS deployments can enforce Secure cookies', async t => {
    const f = await fixture(t, { secureCookies: true });
    const response = await f.request('/api/auth/login', f.json({ password: PASSWORD }));
    assert.match(response.headers.get('set-cookie'), /; Secure/);
});
