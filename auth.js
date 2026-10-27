const crypto = require('node:crypto');

const COOKIE_NAME = 'cloudclip_session';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;

function createAuth({ password, secureCookies = false, now = Date.now, sessionTtl = SESSION_TTL }) {
    if (typeof password !== 'string' || !password.trim()) {
        throw new Error('请先在 .env 或环境变量中设置 ACCESS_PASSWORD，服务未启动。');
    }
    const passwordHash = crypto.createHash('sha256').update(password).digest();
    const sessions = new Map();
    const attempts = new Map();
    const sockets = new Map();

    function sameOrigin(req) {
        if (!req.headers.origin) return true;
        try {
            const origin = new URL(req.headers.origin);
            return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
        } catch {
            return false;
        }
    }

    function tokenFrom(req) {
        const entry = (req.headers.cookie || '').split(';').find(value => value.trim().startsWith(`${COOKIE_NAME}=`));
        return entry ? entry.trim().slice(COOKIE_NAME.length + 1) : '';
    }

    function revoke(token) {
        sessions.delete(token);
        for (const [socket, sessionToken] of sockets) {
            if (sessionToken === token) socket.close(4001, 'Session expired');
        }
    }

    function valid(token) {
        const expiresAt = sessions.get(token);
        if (!expiresAt) return false;
        if (expiresAt <= now()) {
            revoke(token);
            return false;
        }
        return true;
    }

    function cookieOptions(req) {
        return { httpOnly: true, sameSite: 'strict', secure: secureCookies || req.secure, path: '/' };
    }

    function requireAuth(req, res, next) {
        if (!valid(tokenFrom(req))) return res.status(401).json({ error: '请先输入密码登录' });
        next();
    }

    function checkOrigin(req, res, next) {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) {
            return res.status(403).json({ error: '不允许跨站请求' });
        }
        next();
    }

    function login(req, res) {
        const key = req.ip;
        let attempt = attempts.get(key);
        if (attempt && attempt.until <= now()) {
            attempts.delete(key);
            attempt = undefined;
        }
        if ((attempt && attempt.count >= 10) || (!attempt && attempts.size >= 10000)) {
            res.set('Retry-After', String(Math.max(1, Math.ceil(((attempt?.until || now() + LOGIN_WINDOW) - now()) / 1000))));
            return res.status(429).json({ error: '密码错误次数过多，请稍后再试' });
        }
        const input = typeof req.body?.password === 'string' ? req.body.password : '';
        const inputHash = crypto.createHash('sha256').update(input).digest();
        if (!crypto.timingSafeEqual(passwordHash, inputHash)) {
            attempts.set(key, { count: (attempt?.count || 0) + 1, until: attempt?.until || now() + LOGIN_WINDOW });
            return res.status(401).json({ error: '密码错误，请重新输入' });
        }
        attempts.delete(key);
        revoke(tokenFrom(req));
        if (sessions.size >= 1000) revoke(sessions.keys().next().value);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, now() + sessionTtl);
        res.cookie(COOKIE_NAME, token, { ...cookieOptions(req), maxAge: sessionTtl });
        res.json({ success: true });
    }

    function logout(req, res) {
        revoke(tokenFrom(req));
        res.clearCookie(COOKIE_NAME, cookieOptions(req));
        res.json({ success: true });
    }

    function registerSocket(socket, req) {
        const token = tokenFrom(req);
        sockets.set(socket, token);
        const timer = setTimeout(() => revoke(token), Math.max(1, sessions.get(token) - now()));
        timer.unref();
        socket.on('close', () => { clearTimeout(timer); sockets.delete(socket); });
    }

    const cleanup = setInterval(() => {
        for (const token of sessions.keys()) valid(token);
        for (const [key, attempt] of attempts) if (attempt.until <= now()) attempts.delete(key);
    }, 60000);
    cleanup.unref();

    return {
        requireAuth, checkOrigin, login, logout, registerSocket,
        allowUpgrade: req => sameOrigin(req) && valid(tokenFrom(req)),
        allowSocket: socket => valid(sockets.get(socket)),
        close: () => {
            clearInterval(cleanup);
            for (const socket of sockets.keys()) socket.terminate();
            sessions.clear();
        }
    };
}

module.exports = { createAuth };
